'use strict';
// 包装核销更正：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   查询单笔/整卷核销流水，展示更正链与最新有效数量（原核销永不改）；
//   更正成功后卷累计贴用/作废/剩余按各笔最新有效数量重算、修订号 +1、可出货余额同步；
//   多次更正同一笔：每次留痕，以最后一次目标数为准；
//   未知/跨卷核销、非法数量、缺原因、旧修订号整次拒绝且不推进修订号；
//   更正后累计贴用不得低于已分配出货张数（等于允许），贴用+作废不得超过印量（恰好允许）；
//   已永久停用（RETIRED）或因质量隔离暂停贴用的卷不可更正；
//   历史出货分配与明细快照不改；既有核销/出货接口语义保持兼容。
//   node scripts/test-label-corrections.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39129';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-corr-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const correct = (rollId, usageId, body) =>
    api('POST', `/api/label-rolls/${rollId}/usages/${usageId}/correct`, body);
  const usages = (rollId) =>
    api('GET', `/api/label-rolls/${rollId}/usages`).then((x) => x.json);
  const rollOf = async (rollId) => (await usages(rollId)).roll;

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const rel3 = b3.releases.find((r) => r.status === 'ACTIVE');
    const set3 = ['蛋', '乳', '芝麻'];
    const R1 = state0.label_rolls.find((x) => x.roll_code === 'LABEL-0001').id;
    const lotMilkB = state0.materials.find((m) => m.code === 'MILK-01')
      .lots.find((l) => l.lot_code === 'SUP-MILK-20260926-B').id;

    // ---------- 1. 查询：原核销流水与初始累计 ----------
    console.log('1) 查询整卷核销记录：原核销内容、最新有效数量=原数、合计=卷累计');
    let list = await usages(R1);
    check('两笔原核销（100/3、20/2）',
      list.usages.length === 2 &&
      list.usages[0].applied_qty === 100 && list.usages[0].void_qty === 3 &&
      list.usages[1].applied_qty === 20 && list.usages[1].void_qty === 2, list.usages);
    check('无更正时最新有效数量=原数、correction_chain 仅 ORIGINAL',
      list.usages.every((u) => !u.corrected && u.correction_count === 0 &&
        u.correction_chain.length === 1 && u.correction_chain[0].kind === 'ORIGINAL' &&
        u.latest_applied_qty === u.applied_qty && u.latest_void_qty === u.void_qty),
      list.usages);
    check('latest_totals=120/5，allocated=100（SHIP-0001）',
      list.latest_totals.applied === 120 && list.latest_totals.void === 5 &&
      list.allocated_qty === 100, list);
    check('卷对象 120/5/剩375 修订号2',
      list.roll.applied_qty === 120 && list.roll.void_qty === 5 &&
      list.roll.remaining_qty === 375 && list.roll.revision === 2, list.roll);
    let r = await api('GET', `/api/label-rolls/${R1}/usages/2`);
    check('单笔查询 200 且形状一致',
      r.status === 200 && r.json.usage.id === 2 && r.json.usage.used_by === '包装工-赵强', r.json);

    // ---------- 2. 首次更正成功 ----------
    console.log('2) 更正第 2 笔：20/2 → 30/0，卷累计按最新有效数量重算，修订号 +1');
    r = await correct(R1, 2, {
      expected_revision: 2, target_applied: 30, target_voided: 0,
      corrected_by: '仓管-周九', reason: '核销录错：实贴 30，2 张作废误录',
      corrected_at: '2026-10-04T08:30'
    });
    check('更正 200', r.status === 200, r.json);
    check('返回 correction 留痕（目标数/所见修订号/操作人/原因/时间）',
      r.json.correction.target_applied_qty === 30 && r.json.correction.target_void_qty === 0 &&
      r.json.correction.expected_revision === 2 && r.json.correction.corrected_by === '仓管-周九' &&
      r.json.correction.reason.includes('录错') && r.json.correction.corrected_at === '2026-10-04T08:30',
      r.json.correction);
    check('返回卷对象：130 贴 / 3 作废 / 剩 367 / 修订号 3',
      r.json.roll.applied_qty === 130 && r.json.roll.void_qty === 3 &&
      r.json.roll.remaining_qty === 367 && r.json.roll.revision === 3, r.json.roll);
    check('该笔原数不改（20/2），最新有效=30/0，更正链 [ORIGINAL, CORRECTION]',
      r.json.usage.applied_qty === 20 && r.json.usage.void_qty === 2 &&
      r.json.usage.latest_applied_qty === 30 && r.json.usage.latest_void_qty === 0 &&
      r.json.usage.correction_count === 1 &&
      r.json.usage.correction_chain[1].kind === 'CORRECTION' &&
      r.json.usage.correction_chain[1].target_applied_qty === 30, r.json.usage);
    list = await usages(R1);
    check('整卷 latest_totals 按最新有效数量=130/3',
      list.latest_totals.applied === 130 && list.latest_totals.void === 3, list.latest_totals);

    // ---------- 3. 旧修订号整次拒绝、不推进 ----------
    console.log('3) 旧修订号整次拒绝，数量与修订号不变');
    r = await correct(R1, 2, {
      expected_revision: 2, target_applied: 31, target_voided: 0, reason: '重试旧号'
    });
    check('旧修订号 → 409 REVISION_MISMATCH',
      r.status === 409 && r.json.code === 'REVISION_MISMATCH', r.json);
    check('拒绝后仍 130/3 修订号3',
      (await rollOf(R1)).revision === 3 && (await rollOf(R1)).applied_qty === 130);

    // ---------- 4. 同一笔再次更正：链式留痕，以最后一次为准 ----------
    console.log('4) 同一笔第 2 次更正 30/0 → 40/0：原更正保留，最新数取最后一次');
    r = await correct(R1, 2, {
      expected_revision: 3, target_applied: 40, target_voided: 0,
      corrected_by: '仓管-周九', reason: '盘点复核为 40'
    });
    check('第 2 次更正 200，卷 140/3 修订号4',
      r.status === 200 && r.json.roll.applied_qty === 140 &&
      r.json.roll.void_qty === 3 && r.json.roll.revision === 4, r.json.roll);
    r = await api('GET', `/api/label-rolls/${R1}/usages/2`);
    check('更正链长 3：ORIGINAL(20/2) → 30/0 → 40/0，首次更正原样保留',
      r.json.usage.correction_chain.length === 3 &&
      r.json.usage.corrections[0].target_applied_qty === 30 &&
      r.json.usage.corrections[1].target_applied_qty === 40 &&
      r.json.usage.latest_applied_qty === 40 && r.json.usage.applied_qty === 20,
      r.json.usage);

    // ---------- 5. 累计贴用不得低于已分配出货（等于允许） ----------
    console.log('5) 更正后累计贴用低于已分配出货 100 → 拒绝；恰好等于允许');
    r = await correct(R1, 1, {
      expected_revision: 4, target_applied: 50, target_voided: 3, reason: '试改第1笔'
    }); // 50 + 40 = 90 < 100
    check('90 < 已分配100 → 409 BELOW_ALLOCATED，修订号不前进',
      r.status === 409 && r.json.code === 'BELOW_ALLOCATED' &&
      (await rollOf(R1)).revision === 4, r.json);
    r = await correct(R1, 1, {
      expected_revision: 4, target_applied: 60, target_voided: 3, reason: '边界测试'
    }); // 60 + 40 = 100
    check('恰好 100 = 已分配 → 200，修订号5（100/3）',
      r.status === 200 && r.json.roll.applied_qty === 100 &&
      r.json.roll.void_qty === 3 && r.json.roll.revision === 5, r.json.roll);
    // 还原第 1 笔为 100/3
    r = await correct(R1, 1, {
      expected_revision: 5, target_applied: 100, target_voided: 3, reason: '复核后恢复原数'
    });
    check('恢复第 1 笔 → 200，140/3 修订号6',
      r.status === 200 && r.json.roll.applied_qty === 140 && r.json.roll.revision === 6, r.json.roll);

    // ---------- 6. 贴用+作废不得超过印量（恰好允许） ----------
    console.log('6) 更正后贴用+作废超印量 → 拒绝；恰好等于印量允许');
    r = await correct(R1, 1, {
      expected_revision: 6, target_applied: 100, target_voided: 400, reason: '超量测试'
    }); // 140 + 400 = 540 > 500
    check('合计 540 > 印量 500 → 409 OVER_LIMIT，修订号不前进',
      r.status === 409 && r.json.code === 'OVER_LIMIT' &&
      (await rollOf(R1)).revision === 6, r.json);
    r = await correct(R1, 1, {
      expected_revision: 6, target_applied: 100, target_voided: 360, reason: '贴满边界'
    }); // 140 + 360 = 500
    check('合计恰 500 → 200，剩 0，修订号7',
      r.status === 200 && r.json.roll.remaining_qty === 0 && r.json.roll.revision === 7, r.json.roll);
    r = await correct(R1, 1, {
      expected_revision: 7, target_applied: 100, target_voided: 3, reason: '恢复作废数'
    });
    check('恢复作废 → 200，140/3/剩357 修订号8',
      r.status === 200 && r.json.roll.applied_qty === 140 && r.json.roll.void_qty === 3 &&
      r.json.roll.remaining_qty === 357 && r.json.roll.revision === 8, r.json.roll);

    // ---------- 7. 非法参数整次拒绝 ----------
    console.log('7) 非法数量/缺原因/缺修订号/错时间格式 → 400，修订号不前进');
    const badBodies = [
      { expected_revision: 8, target_applied: -1, target_voided: 0, reason: 'x' },
      { expected_revision: 8, target_applied: 1.5, target_voided: 0, reason: 'x' },
      { expected_revision: 8, target_applied: 40, target_voided: 'abc', reason: 'x' },
      { expected_revision: 8, target_applied: 40, target_voided: 0 },
      { expected_revision: 8, target_voided: 0, reason: 'x' },
      { expected_revision: -1, target_applied: 40, target_voided: 0, reason: 'x' },
      { expected_revision: 8, target_applied: 40, target_voided: 0, reason: 'x', corrected_at: 'bad' }
    ];
    for (const b of badBodies) {
      const rr = await correct(R1, 2, b);
      check(`拒绝 ${JSON.stringify(b).slice(0, 48)}`,
        rr.status === 400 && rr.json.code === 'INVALID_REQUEST', rr.json);
    }
    check('全部非法请求后修订号仍 8', (await rollOf(R1)).revision === 8);
    // 目标数与现值相同（零变化更正）允许且仍推进修订号
    r = await correct(R1, 2, {
      expected_revision: 8, target_applied: 40, target_voided: 0, reason: '维持现值留痕'
    });
    check('目标数=现值允许更正，数量不变、修订号→9',
      r.status === 200 && r.json.roll.applied_qty === 140 && r.json.roll.revision === 9, r.json.roll);

    // ---------- 8. 未知 / 跨卷核销 ----------
    console.log('8) 未知核销 404；跨卷更正/查询拒绝；卷不存在 404');
    r = await correct(R1, 999999, {
      expected_revision: 9, target_applied: 1, target_voided: 0, reason: 'x'
    });
    check('未知核销编号 → 404 USAGE_NOT_FOUND，修订号不前进',
      r.status === 404 && r.json.code === 'USAGE_NOT_FOUND' &&
      (await rollOf(R1)).revision === 9, r.json);
    r = await api('GET', `/api/label-rolls/${R1}/usages/999999`);
    check('查询未知核销 → 404', r.status === 404 && r.json.code === 'USAGE_NOT_FOUND', r.json);

    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3.id, allergens: set3, print_qty: 10
    });
    check('登记第二卷 LABEL-0002 成功', r.status === 200 && r.json.roll_code === 'LABEL-0002', r.json);
    const R2 = r.json.id;
    r = await correct(R2, 1, { expected_revision: 0, target_applied: 1, target_voided: 0, reason: 'x' });
    check('跨卷更正（卷2 改卷1 的核销）→ 400 USAGE_ROLL_MISMATCH',
      r.status === 400 && r.json.code === 'USAGE_ROLL_MISMATCH', r.json);
    r = await api('GET', `/api/label-rolls/${R2}/usages/1`);
    check('跨卷查询 → 400 USAGE_ROLL_MISMATCH',
      r.status === 400 && r.json.code === 'USAGE_ROLL_MISMATCH', r.json);
    r = await api('GET', '/api/label-rolls/9999/usages');
    check('不存在的卷 → 404 ROLL_NOT_FOUND',
      r.status === 404 && r.json.code === 'ROLL_NOT_FOUND', r.json);

    // ---------- 9. 可出货余额同步、历史出货快照不改 ----------
    console.log('9) 可出货余额随最新有效贴用数同步；历史出货分配与快照不改');
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    const balRow = r.json.rolls.find((x) => x.roll_id === R1);
    check('卷1 已贴140/已分配100/可出货40',
      balRow.applied_qty === 140 && balRow.allocated_qty === 100 &&
      balRow.available_qty === 40 && r.json.shippable_qty >= 40, balRow);
    let st = (await api('GET', '/api/state')).json;
    const sRoll1 = st.label_rolls.find((x) => x.id === R1);
    check('/api/state 既有字段语义：shippable_qty=40，applied/void/revision 已同步',
      sRoll1.shippable_qty === 40 && sRoll1.applied_qty === 140 &&
      sRoll1.void_qty === 3 && sRoll1.revision === 9, sRoll1);
    let ship = (await api('GET', '/api/shipments?status=SHIPPED')).json
      .find((s) => s.shipment_code === 'SHIP-0001');
    check('SHIP-0001 仍 SHIPPED，明细快照 qty=100、修订号=2（出货当时）',
      ship && ship.status === 'SHIPPED' && ship.items[0].qty === 100 &&
      ship.items[0].roll_revision === 2, ship);

    // ---------- 10. 新出货后再下调贴用被拒，上调后余额同步增加 ----------
    console.log('10) 新出货占用：下调致低于已分配拒绝；上调后可出货余额增加');
    r = await api('POST', `/api/label-rolls/${R2}/consume`,
      { expected_revision: 0, applied: 5, voided: 0, used_by: '包装工' });
    check('卷2 核销 5 张贴用成功（既有核销接口兼容），修订号1',
      r.status === 200 && r.json.applied_qty === 5 && r.json.revision === 1, r.json);
    const u2 = (await usages(R2)).usages[0];
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 5, shipped_by: '仓管-孙倩',
      allocations: [{ roll_id: R2, qty: 5 }]
    });
    check('从卷2 出货 5 张成功 SHIP-0002（既有关联出货接口兼容）',
      r.status === 200 && r.json.shipment_code === 'SHIP-0002', r.json);
    r = await correct(R2, u2.id, {
      expected_revision: 1, target_applied: 3, target_voided: 0, reason: '试下调到已分配以下'
    });
    check('贴用 3 < 已分配 5 → 409 BELOW_ALLOCATED，修订号不前进',
      r.status === 409 && r.json.code === 'BELOW_ALLOCATED' &&
      (await rollOf(R2)).revision === 1, r.json);
    r = await correct(R2, u2.id, {
      expected_revision: 1, target_applied: 10, target_voided: 0, reason: '实为 10 张'
    });
    check('上调至 10（合计=印量）→ 200，修订号2，剩0',
      r.status === 200 && r.json.roll.applied_qty === 10 &&
      r.json.roll.remaining_qty === 0 && r.json.roll.revision === 2, r.json.roll);
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    const bal2 = r.json.rolls.find((x) => x.roll_id === R2);
    check('卷2 余额同步：已贴10/已分配5/可出货5',
      bal2.applied_qty === 10 && bal2.allocated_qty === 5 && bal2.available_qty === 5, bal2);

    // ---------- 11. 质量隔离暂停贴用期间不可更正 ----------
    console.log('11) 批次被质量隔离令覆盖时不可更正（不永久停用）；解除后恢复');
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: lotMilkB, reason: '供应商通报该批可能混入异常原料',
      issued_by: '质检员-王敏', issued_at: '2026-10-04T09:00'
    });
    check('签发隔离令 QUAR-0001，BATCH-003 受控',
      r.status === 200 && r.json.order.order_code === 'QUAR-0001', r.json);
    const quarId = r.json.order.id;
    r = await correct(R1, 2, { expected_revision: 9, target_applied: 45, target_voided: 0, reason: '隔离期试改' });
    check('隔离期更正 → 409 ROLL_QUARANTINED，修订号不前进',
      r.status === 409 && r.json.code === 'ROLL_QUARANTINED' &&
      (await rollOf(R1)).revision === 9, r.json);
    st = (await api('GET', '/api/state')).json;
    check('卷1 仍 ACTIVE（仅暂停，不永久停用）',
      st.label_rolls.find((x) => x.id === R1).status === 'ACTIVE', st.label_rolls);
    r = await api('POST', `/api/quarantine-orders/${quarId}/lift`,
      { lifted_by: '质检主管-刘芳', lift_reason: '复检合格', lifted_at: '2026-10-04T10:00' });
    check('解除隔离 200', r.status === 200, r.json);
    r = await correct(R1, 2, { expected_revision: 9, target_applied: 45, target_voided: 0, reason: '解除后复核为45' });
    check('解除后更正恢复：145/3 修订号10',
      r.status === 200 && r.json.roll.applied_qty === 145 &&
      r.json.roll.void_qty === 3 && r.json.roll.revision === 10, r.json.roll);

    // ---------- 12. 永久停用卷不可更正；流水与更正链仍可查 ----------
    console.log('12) 已永久停用（RETIRED）的卷不可更正；历史流水/更正链/快照均保留');
    r = await api('DELETE', `/api/releases/${rel3.id}`);
    check('删除放行 200，卷1/卷2 均被永久停用',
      r.status === 200 && r.json.retired_rolls.some((x) => x.id === R1) &&
      r.json.retired_rolls.some((x) => x.id === R2), r.json.retired_rolls);
    r = await correct(R1, 2, { expected_revision: 10, target_applied: 46, target_voided: 0, reason: '停用后试改' });
    check('停用卷更正 → 409 ROLL_RETIRED，修订号不前进',
      r.status === 409 && r.json.code === 'ROLL_RETIRED' &&
      (await rollOf(R1)).revision === 10, r.json);
    list = await usages(R1);
    check('停用后流水仍可查：原数不改、最新有效=145/3 汇总、更正链完整（第2笔4条）',
      list.roll.status === 'RETIRED' &&
      list.usages[1].applied_qty === 20 && list.usages[1].void_qty === 2 &&
      list.usages[1].latest_applied_qty === 45 && list.usages[1].latest_void_qty === 0 &&
      list.usages[1].correction_chain.length === 5 &&
      list.usages[1].correction_count === 4 &&
      list.latest_totals.applied === 145 && list.latest_totals.void === 3, list);
    ship = (await api('GET', '/api/shipments')).json.find((s) => s.shipment_code === 'SHIP-0001');
    check('SHIP-0001 因卷停用转 PENDING_REVIEW，但明细快照不改（qty=100/修订号=2）',
      ship.status === 'PENDING_REVIEW' && ship.items[0].qty === 100 &&
      ship.items[0].roll_revision === 2, ship);
    const ship2 = (await api('GET', '/api/shipments')).json.find((s) => s.shipment_code === 'SHIP-0002');
    check('SHIP-0002 同样 PENDING_REVIEW，快照 qty=5（历史出货分配不改）',
      ship2.status === 'PENDING_REVIEW' && ship2.items[0].qty === 5, ship2);

  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  if (failures) {
    console.error(`\n失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
