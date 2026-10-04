'use strict';
// 过敏原标签卷。
//
// 登记（包装前）：按“现有批次 + 有效放行记录”登记一卷过敏原标签。
//   拟印过敏原集合必须与①该批次当前推导结果、②所选放行快照“完全一致”（三方一致），
//   印量为正整数；登记后返回卷号与可用张数。
//
// 核销：每卷凭“预期修订号”核销贴用与作废张数，累计不得超过印量。
//   旧修订号、负数、超量均整次拒绝（事务回滚，修订号不前进）。
//
// 核销更正：核销录错后，仓管可对“同一标签卷”的某一笔贴用/作废记录提交更正
//   （原核销编号 usage_id、所见卷修订号 expected_revision、目标贴用数、目标作废数、
//    操作人 corrected_by、原因 reason；目标数均为非负整数，允许与现值相同）。
//   原核销行与每次更正均只增不改，每笔以最后一次更正的目标数为最新有效数量；
//   卷累计贴用/作废/剩余按各笔最新有效数量重算，成功后修订号 +1。
//   更正后累计贴用不得低于该卷已分配出货张数，累计贴用 + 作废不得超过印量；
//   已永久停用（RETIRED）或因质量隔离暂停贴用的卷不可更正；
//   历史出货分配与明细快照不改，可出货余额随最新有效贴用数同步更新。
//   未知/跨卷核销、非法数量、旧修订号均整次拒绝且不推进修订号。
//
// 永久停用：原料或加工事件变更、换线整组确认应用使集合改变，或绑定放行失效/删除时，
//   该卷永久停用（RETIRED，终态）：已贴数量标记待复核，余量不可再贴；
//   即使集合后来恢复也不自动解冻。

class LabelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LabelError';
    this.code = code;
    this.details = details || [];
  }
}

function sortedSet(list) {
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}
function canonical(list) {
  return JSON.stringify(sortedSet(list));
}

function intNonNeg(v, field, { positive = false } = {}) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(v, 10);
  if (!Number.isInteger(n)) {
    throw new LabelError('INVALID_REQUEST', `${field}必须是${positive ? '正' : '非负'}整数`);
  }
  if (positive ? n <= 0 : n < 0) {
    throw new LabelError('INVALID_REQUEST', `${field}必须${positive ? '大于 0' : '不小于 0'}`);
  }
  return n;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// ---------- 登记一卷 ----------
function registerRoll(db, body) {
  const batch_id = parseInt(body && body.batch_id, 10);
  if (!Number.isInteger(batch_id)) throw new LabelError('INVALID_REQUEST', '请选择批次');
  const release_id = parseInt(body && body.release_id, 10);
  if (!Number.isInteger(release_id)) throw new LabelError('INVALID_REQUEST', '请选择有效放行记录');
  const print_qty = intNonNeg(body && body.print_qty, '印量', { positive: true });
  if (print_qty > 1e9) throw new LabelError('INVALID_REQUEST', '印量超出允许范围');
  const registered_by = String((body && body.registered_by) || '').trim() || '未署名';
  const registered_at = String((body && body.registered_at) || '').trim();
  if (registered_at && !TIME_RE.test(registered_at)) {
    throw new LabelError('INVALID_REQUEST', '登记时间格式应为 YYYY-MM-DDTHH:MM');
  }
  const declared = Array.isArray(body && body.allergens) ? body.allergens : null;
  if (!declared) throw new LabelError('INVALID_REQUEST', '请录入拟印过敏原集合');
  const declaredSet = sortedSet(declared);

  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batch_id);
  if (!batch) throw new LabelError('BATCH_NOT_FOUND', '该批次不存在');
  const out = db.prepare('SELECT allergens FROM batch_outputs WHERE batch_id = ?').get(batch_id);
  const ev = db.prepare('SELECT id FROM events WHERE batch_id = ?').get(batch_id);
  if (!out || !ev) throw new LabelError('BATCH_NOT_PRODUCED', '该批次尚无加工记录，无法登记标签卷');

  // 质量隔离令：受控批次不得登记标签卷（解除或流向变化脱离全部生效令后恢复）。
  const quarantine = require('./quarantine');
  const qOrders = quarantine.batchOrders(db, batch_id);
  if (qOrders.length) {
    throw new LabelError(
      'BATCH_QUARANTINED',
      `批次 ${batch.code} 处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
      '隔离期间不得登记标签卷；解除隔离或流向变化脱离全部生效令后恢复'
    );
  }

  const release = db.prepare(
    'SELECT id, batch_id, status, snapshot_allergens FROM releases WHERE id = ?'
  ).get(release_id);
  if (!release) throw new LabelError('RELEASE_NOT_FOUND', '所选放行记录不存在');
  if (release.batch_id !== batch_id) {
    throw new LabelError(
      'RELEASE_BATCH_MISMATCH',
      '所选放行快照不属于该批次，请选择该批次自己的有效放行记录'
    );
  }
  if (release.status !== 'ACTIVE') {
    throw new LabelError('RELEASE_INACTIVE', '所选放行记录已失效，请按当前结果重新登记放行后再包装');
  }

  const currentSet = sortedSet(JSON.parse(out.allergens));
  const snapshotSet = sortedSet(JSON.parse(release.snapshot_allergens));
  const declaredJson = JSON.stringify(declaredSet);
  if (declaredJson !== JSON.stringify(currentSet) || declaredJson !== JSON.stringify(snapshotSet)) {
    throw new LabelError('ALLERGENS_MISMATCH',
      '拟印过敏原集合与当前批次推导结果或所选放行快照不完全一致，拒绝登记',
      [
        `拟印集合：${declaredSet.join('、') || '（空）'}`,
        `当前批次推导：${currentSet.join('、') || '（空）'}`,
        `放行快照：${snapshotSet.join('、') || '（空）'}`
      ]);
  }

  let rollId;
  const tx = db.transaction(() => {
    rollId = db.prepare(
      `INSERT INTO label_rolls
         (roll_code, batch_id, release_id, print_qty, applied_qty, void_qty,
          revision, allergen_set, registered_at, registered_by, status, retired_reason)
       VALUES ('', ?, ?, ?, 0, 0, 0, ?, COALESCE(?, datetime('now')), ?, 'ACTIVE', '')`
    ).run(batch_id, release_id, print_qty, declaredJson, registered_at || null, registered_by)
      .lastInsertRowid;
    const roll_code = `LABEL-${String(rollId).padStart(4, '0')}`;
    db.prepare('UPDATE label_rolls SET roll_code = ? WHERE id = ?').run(roll_code, rollId);
  });
  tx();

  return formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId));
}

// ---------- 核销贴用 / 作废 ----------
function consumeRoll(db, id, body) {
  const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  if (roll.status !== 'ACTIVE') {
    throw new LabelError(
      'ROLL_RETIRED',
      `该卷已永久停用（${roll.retired_reason || '见停用原因'}），余量不可再贴；已贴数量待复核`,
      [roll.retired_reason]
    );
  }
  const expected_revision = parseInt(body && body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision < 0) {
    throw new LabelError('INVALID_REQUEST', '请提供预期修订号（非负整数）');
  }
  // applied / voided 为文档用语；兼容 used/void_qty 别名。
  const applied = intNonNeg(body && body.applied != null ? body.applied : body && body.used, '贴用张数');
  const voided = intNonNeg(body && body.voided != null ? body.voided : body && body.void_qty, '作废张数');
  if (applied === 0 && voided === 0) {
    throw new LabelError('INVALID_REQUEST', '贴用与作废张数均为 0，无内容可核销');
  }
  const used_by = String((body && body.used_by) || (body && body.operator) || '').trim() || '未署名';
  const used_at = String((body && body.used_at) || '').trim();
  if (used_at && !TIME_RE.test(used_at)) {
    throw new LabelError('INVALID_REQUEST', '核销时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let result;
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT revision, applied_qty, void_qty, print_qty FROM label_rolls WHERE id = ?').get(id);
    if (!cur) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
    // 质量隔离令：所属批次受控时暂停贴用（不永久停用；脱离全部生效令后恢复核销）。
    const quarantine = require('./quarantine');
    const qOrders = quarantine.batchOrders(db, roll.batch_id);
    if (qOrders.length) {
      throw new LabelError(
        'ROLL_QUARANTINED',
        `卷 ${roll.roll_code} 所属批次处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
        '已暂停贴用（不永久停用）；解除隔离或流向变化脱离全部生效令后恢复'
      );
    }
    if (cur.revision !== expected_revision) {
      throw new LabelError(
        'REVISION_MISMATCH',
        `修订号已过期：卷当前修订号为 ${cur.revision}，提交的预期修订号为 ${expected_revision}；整次拒绝`
      );
    }
    const nextApplied = cur.applied_qty + applied;
    const nextVoid = cur.void_qty + voided;
    if (nextApplied + nextVoid > cur.print_qty) {
      throw new LabelError(
        'OVER_LIMIT',
        `超过印量：印量 ${cur.print_qty}，已贴 ${cur.applied_qty}、已作废 ${cur.void_qty}，` +
        `本次申请贴用 ${applied}、作废 ${voided}，核销后累计 ${nextApplied + nextVoid} 超过印量；整次拒绝`
      );
    }
    db.prepare(
      `INSERT INTO label_roll_usages (roll_id, used_at, applied_qty, void_qty, expected_revision, used_by)
       VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`
    ).run(id, used_at || null, applied, voided, expected_revision, used_by);
    db.prepare(
      'UPDATE label_rolls SET applied_qty = ?, void_qty = ?, revision = revision + 1 WHERE id = ?'
    ).run(nextApplied, nextVoid, id);
    result = formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id));
  });
  tx();
  return result;
}

// ---------- 核销更正（更正同一卷的一笔贴用/作废记录） ----------
// body: { usage_id, expected_revision, target_applied?, target_voided?,
//         corrected_by/operator?, reason?, corrected_at? }
// 目标数量字段兼容别名 applied/used、voided/void_qty。
function correctUsage(db, rollId, body) {
  const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  if (roll.status !== 'ACTIVE') {
    throw new LabelError(
      'ROLL_RETIRED',
      `该卷已永久停用（${roll.retired_reason || '见停用原因'}），不可更正核销记录`,
      [roll.retired_reason]
    );
  }

  const usage_id = parseInt(body && body.usage_id, 10);
  if (!Number.isInteger(usage_id) || usage_id <= 0) {
    throw new LabelError('INVALID_REQUEST', '请提供原核销编号（正整数 usage_id）');
  }
  const expected_revision = parseInt(body && body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision < 0) {
    throw new LabelError('INVALID_REQUEST', '请提供所见卷修订号（非负整数 expected_revision）');
  }
  const targetApplied = intNonNeg(
    body && (body.target_applied != null ? body.target_applied
      : body.applied != null ? body.applied : body.used),
    '目标贴用数'
  );
  const targetVoid = intNonNeg(
    body && (body.target_voided != null ? body.target_voided
      : body.target_void_qty != null ? body.target_void_qty
        : body.voided != null ? body.voided : body.void_qty),
    '目标作废数'
  );
  const corrected_by = String(
    (body && (body.corrected_by || body.operator)) || ''
  ).trim() || '未署名';
  const reason = String((body && body.reason) || '').trim();
  if (!reason) throw new LabelError('INVALID_REQUEST', '请录入更正原因');
  const corrected_at = String((body && body.corrected_at) || '').trim();
  if (corrected_at && !TIME_RE.test(corrected_at)) {
    throw new LabelError('INVALID_REQUEST', '更正时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let result;
  const tx = db.transaction(() => {
    const cur = db.prepare(
      'SELECT revision, applied_qty, void_qty, print_qty, batch_id, roll_code, status FROM label_rolls WHERE id = ?'
    ).get(rollId);
    if (!cur) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
    if (cur.status !== 'ACTIVE') {
      throw new LabelError('ROLL_RETIRED', '该卷已永久停用，不可更正核销记录');
    }
    // 质量隔离令：所属批次受控时暂停贴用，核销更正同样拒绝（不永久停用；脱离生效令后恢复）。
    const quarantine = require('./quarantine');
    const qOrders = quarantine.batchOrders(db, cur.batch_id);
    if (qOrders.length) {
      throw new LabelError(
        'ROLL_QUARANTINED',
        `卷 ${cur.roll_code} 所属批次处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
        '已暂停贴用，不可更正核销记录；解除隔离或流向变化脱离全部生效令后恢复'
      );
    }
    if (cur.revision !== expected_revision) {
      throw new LabelError(
        'REVISION_MISMATCH',
        `修订号已过期：卷当前修订号为 ${cur.revision}，提交的所见修订号为 ${expected_revision}；整次拒绝`
      );
    }

    const usage = db.prepare('SELECT * FROM label_roll_usages WHERE id = ?').get(usage_id);
    if (!usage) {
      throw new LabelError('USAGE_NOT_FOUND', `原核销编号 ${usage_id} 不存在；整次拒绝`);
    }
    if (usage.roll_id !== rollId) {
      const other = db.prepare('SELECT roll_code FROM label_rolls WHERE id = ?').get(usage.roll_id);
      throw new LabelError(
        'USAGE_ROLL_MISMATCH',
        `原核销编号 ${usage_id} 属于卷 ${other ? other.roll_code : '#' + usage.roll_id}，` +
          `不属于卷 ${cur.roll_code}；不可跨卷更正，整次拒绝`
      );
    }

    // 各笔最新有效数量之和 = 卷累计（原核销与历次更正均只增不改）。
    const totals = rollTotals(db, rollId);
    const eff = usageEffective(db, usage_id);
    const nextApplied = totals.applied - eff.applied + targetApplied;
    const nextVoid = totals.void - eff.void + targetVoid;

    // 已分配出货张数：出货明细只增不改（待评估单也持续占用其分配量）。
    const allocRow = db.prepare(
      'SELECT COALESCE(SUM(qty),0) AS n FROM shipment_items WHERE roll_id = ?'
    ).get(rollId);
    const allocated = allocRow.n;
    if (nextApplied < allocated) {
      throw new LabelError(
        'BELOW_ALLOCATED',
        `更正后该卷累计贴用为 ${nextApplied} 张，低于已分配出货 ${allocated} 张；` +
          '历史出货分配不改，整次拒绝',
        [`目标贴用 ${targetApplied}、目标作废 ${targetVoid}`]
      );
    }
    if (nextApplied + nextVoid > cur.print_qty) {
      throw new LabelError(
        'OVER_LIMIT',
        `超过印量：印量 ${cur.print_qty}，按各笔最新有效数量重算后累计贴用 ${nextApplied}、` +
          `作废 ${nextVoid}，合计 ${nextApplied + nextVoid} 超过印量；整次拒绝`,
        [`目标贴用 ${targetApplied}、目标作废 ${targetVoid}`]
      );
    }

    const corrInfo = db.prepare(
      `INSERT INTO label_roll_usage_corrections
         (usage_id, roll_id, target_applied_qty, target_void_qty,
          expected_revision, corrected_by, reason, corrected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).run(usage_id, rollId, targetApplied, targetVoid,
          expected_revision, corrected_by, reason, corrected_at || null);
    db.prepare(
      'UPDATE label_rolls SET applied_qty = ?, void_qty = ?, revision = revision + 1 WHERE id = ?'
    ).run(nextApplied, nextVoid, rollId);

    result = {
      correction: formatCorrection(
        db.prepare('SELECT * FROM label_roll_usage_corrections WHERE id = ?').get(corrInfo.lastInsertRowid)
      ),
      usage: formatUsage(db.prepare('SELECT * FROM label_roll_usages WHERE id = ?').get(usage_id), db),
      roll: formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId))
    };
  });
  tx();
  return result;
}

// 单笔核销的最新有效数量：有更正取最后一次更正的目标数，否则取原核销数量。
function usageEffective(db, usageId) {
  const row = db.prepare(
    `SELECT u.applied_qty, u.void_qty,
            (SELECT c.target_applied_qty FROM label_roll_usage_corrections c
              WHERE c.usage_id = u.id ORDER BY c.id DESC LIMIT 1) AS corr_applied,
            (SELECT c.target_void_qty FROM label_roll_usage_corrections c
              WHERE c.usage_id = u.id ORDER BY c.id DESC LIMIT 1) AS corr_void
       FROM label_roll_usages u WHERE u.id = ?`
  ).get(usageId);
  if (!row) return null;
  return {
    applied: row.corr_applied == null ? row.applied_qty : row.corr_applied,
    void: row.corr_void == null ? row.void_qty : row.corr_void
  };
}

// 卷累计：各笔核销最新有效数量之和（更正后据此重算 applied_qty/void_qty）。
function rollTotals(db, rollId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(
              (SELECT c.target_applied_qty FROM label_roll_usage_corrections c
                WHERE c.usage_id = u.id ORDER BY c.id DESC LIMIT 1),
              u.applied_qty)), 0) AS applied,
            COALESCE(SUM(COALESCE(
              (SELECT c.target_void_qty FROM label_roll_usage_corrections c
                WHERE c.usage_id = u.id ORDER BY c.id DESC LIMIT 1),
              u.void_qty)), 0) AS used_void
       FROM label_roll_usages u WHERE u.roll_id = ?`
  ).get(rollId);
  return { applied: row.applied, void: row.used_void };
}

// ---------- 核销流水 / 更正链读取模型 ----------
function formatCorrection(c) {
  if (!c) return null;
  return {
    id: c.id,
    seq: c.id,
    usage_id: c.usage_id,
    roll_id: c.roll_id,
    target_applied_qty: c.target_applied_qty,
    target_void_qty: c.target_void_qty,
    expected_revision: c.expected_revision,
    corrected_by: c.corrected_by,
    reason: c.reason,
    corrected_at: c.corrected_at
  };
}

// 一笔核销记录：原核销内容只增不改；correction_chain 为 [原核销, 历次更正…]；
// latest_* 为该笔最新有效数量（无更正时等于原核销数量）。
function formatUsage(u, db) {
  if (!u) return null;
  const corrections = db
    ? db.prepare('SELECT * FROM label_roll_usage_corrections WHERE usage_id = ? ORDER BY id')
      .all(u.id).map(formatCorrection)
    : [];
  const last = corrections.length ? corrections[corrections.length - 1] : null;
  return {
    id: u.id,
    roll_id: u.roll_id,
    used_at: u.used_at,
    applied_qty: u.applied_qty,        // 原核销贴用（只增不改）
    void_qty: u.void_qty,              // 原核销作废（只增不改）
    expected_revision: u.expected_revision,
    used_by: u.used_by,
    corrected: corrections.length > 0,
    correction_count: corrections.length,
    latest_applied_qty: last ? last.target_applied_qty : u.applied_qty,
    latest_void_qty: last ? last.target_void_qty : u.void_qty,
    corrections,
    // 更正链：首项为原核销（kind:'ORIGINAL'），其后为每次更正（kind:'CORRECTION'）。
    correction_chain: [
      {
        kind: 'ORIGINAL',
        id: u.id,
        applied_qty: u.applied_qty,
        void_qty: u.void_qty,
        expected_revision: u.expected_revision,
        operator: u.used_by,
        at: u.used_at
      },
      ...corrections.map((c) => ({
        kind: 'CORRECTION',
        id: c.id,
        target_applied_qty: c.target_applied_qty,
        target_void_qty: c.target_void_qty,
        expected_revision: c.expected_revision,
        operator: c.corrected_by,
        reason: c.reason,
        at: c.corrected_at
      }))
    ]
  };
}

function getRollUsage(db, rollId, usageId) {
  const roll = db.prepare('SELECT id FROM label_rolls WHERE id = ?').get(rollId);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  const u = db.prepare('SELECT * FROM label_roll_usages WHERE id = ?').get(usageId);
  if (!u) throw new LabelError('USAGE_NOT_FOUND', `原核销编号 ${usageId} 不存在`);
  if (u.roll_id !== rollId) {
    throw new LabelError(
      'USAGE_ROLL_MISMATCH',
      `原核销编号 ${usageId} 不属于该卷，不可跨卷查询`
    );
  }
  return { usage: formatUsage(u, db) };
}

function listRollUsages(db, rollId) {
  const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  const usages = db.prepare(
    'SELECT * FROM label_roll_usages WHERE roll_id = ? ORDER BY id'
  ).all(rollId).map((u) => formatUsage(u, db));
  const totals = rollTotals(db, rollId);
  return {
    roll: formatRoll(roll),
    allocated_qty: db.prepare(
      'SELECT COALESCE(SUM(qty),0) AS n FROM shipment_items WHERE roll_id = ?'
    ).get(rollId).n,
    // 各笔最新有效数量合计（与卷当前累计一致）。
    latest_totals: totals,
    usages
  };
}

// ---------- 终态停用 ----------
function deactivateRolls(db, ids, reason) {
  const list = Array.isArray(ids) ? ids : [ids];
  const stmt = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ?
      WHERE id = ? AND status = 'ACTIVE'`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const id of list) count += stmt.run(reason, id).changes;
  });
  tx();
  return count;
}

// 放行被删除：其名下所有有效卷永久停用（放行已不存在，无法再保持一致）。
function deactivateForReleaseDeletion(db, releaseId) {
  const release = db.prepare(
    `SELECT r.id, r.batch_id, b.code AS batch_code, r.released_at
       FROM releases r LEFT JOIN batches b ON b.id = r.batch_id WHERE r.id = ?`
  ).get(releaseId);
  const reason = `绑定的放行记录已删除（批次 ${release ? release.batch_code || '#' + release.batch_id : '?'}，` +
    `放行时间 ${release ? release.released_at : '?'}），标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE release_id = ? AND status = 'ACTIVE'"
  ).all(releaseId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 加工事件删除致批次连带删除的兜底：该批次剩余有效卷永久停用。
function deactivateForBatchDeletion(db, batchId, batchCode) {
  const reason = `批次 ${batchCode || '#' + batchId} 的加工事件已删除，标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE batch_id = ? AND status = 'ACTIVE'"
  ).all(batchId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 重算后核对：对所有仍有效的卷检查“绑定放行 / 批次 / 集合”是否仍一致。
// 只在重算事务内调用；停用为终态，不做任何“解冻”。
function syncRollsAfterRecompute(db, batchResult) {
  const rollRows = db.prepare(
    `SELECT lr.id, lr.roll_code, lr.batch_id, lr.release_id, lr.allergen_set,
            b.code AS batch_code
       FROM label_rolls lr LEFT JOIN batches b ON b.id = lr.batch_id
      WHERE lr.status = 'ACTIVE'`
  ).all();
  const upd = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ? WHERE id = ?`
  );
  const retired = [];
  for (const roll of rollRows) {
    let reason = null;

    if (roll.release_id == null) {
      reason = '绑定的放行记录已删除，标签卷永久停用';
    } else {
      const release = db.prepare('SELECT status, invalid_reason FROM releases WHERE id = ?')
        .get(roll.release_id);
      if (!release) {
        reason = '绑定的放行记录已删除，标签卷永久停用';
      } else if (release.status === 'INVALIDATED') {
        reason = `绑定放行已失效：${release.invalid_reason || '放行快照与当前推导结果不一致'}；标签卷永久停用`;
      }
    }

    if (!reason) {
      const result = batchResult.get(roll.batch_id);
      if (!result) {
        reason = '该批次的加工事件已不存在，无法重新推导过敏原，标签卷永久停用';
      } else if (canonical([...result.keys()]) !== roll.allergen_set) {
        const oldSet = JSON.parse(roll.allergen_set);
        const newSet = [...result.keys()];
        const added = newSet.filter((a) => !oldSet.includes(a));
        const removed = oldSet.filter((a) => !newSet.includes(a));
        const parts = [];
        if (added.length) parts.push(`新增：${added.join('、')}`);
        if (removed.length) parts.push(`移除：${removed.join('、')}`);
        reason = `批次过敏原集合已改变（${parts.join('；') || '集合内容变化'}），与拟印集合不一致，标签卷永久停用`;
      }
    }

    if (reason) {
      upd.run(reason, roll.id);
      retired.push({
        id: roll.id, roll_code: roll.roll_code,
        batch_code: roll.batch_code || null, reason,
        applied_pending_review: db.prepare(
          'SELECT applied_qty FROM label_rolls WHERE id = ?'
        ).get(roll.id).applied_qty
      });
    }
  }
  return retired;
}

// ---------- 读取模型 ----------
function formatRoll(r) {
  if (!r) return null;
  const applied = r.applied_qty || 0;
  const voided = r.void_qty || 0;
  const print = r.print_qty || 0;
  return {
    id: r.id,
    roll_code: r.roll_code,
    batch_id: r.batch_id,
    release_id: r.release_id,
    allergens: JSON.parse(r.allergen_set || '[]'),
    print_qty: print,
    applied_qty: applied,
    void_qty: voided,
    remaining_qty: print - applied - voided,
    revision: r.revision,
    registered_at: r.registered_at,
    registered_by: r.registered_by,
    status: r.status,
    active: r.status === 'ACTIVE',
    retired_reason: r.retired_reason || '',
    applied_pending_review: r.status === 'RETIRED' ? applied : 0
  };
}

module.exports = {
  LabelError,
  registerRoll,
  consumeRoll,
  correctUsage,
  getRollUsage,
  listRollUsages,
  rollTotals,
  formatUsage,
  deactivateForReleaseDeletion,
  deactivateForBatchDeletion,
  syncRollsAfterRecompute,
  formatRoll
};
