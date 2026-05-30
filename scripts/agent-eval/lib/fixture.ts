/**
 * Disposable medium-hard fixture repo for the agent evaluation harness.
 *
 * Motivation vs Logic: the agent's validation runner detects an npm `test`
 * script and runs `npm run test`. We use Node's built-in `node --test` runner so
 * the suite runs with ZERO installs (no node_modules), keeping the real-system
 * test deterministic. A deliberate logic bug + a failing test give the agent a
 * concrete, verifiable task and let us observe the diff gate + validation +
 * repair loop end-to-end.
 *
 * The default fixture lives OUTSIDE the Codoptic repo (a sibling under the user's
 * Downloads folder) because guardPath blocks /var (macOS os.tmpdir) and we do not
 * want to pollute Codoptic's own scan surface.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface FixtureOptions {
  /** Absolute path for the fixture root. */
  root: string;
  /** Initialize a git repo (and commit) so git-diff paths are exercised. */
  git: boolean;
  /** Seed a deliberate failing-test bug into the inventory module. */
  withBug: boolean;
}

const FILES = (withBug: boolean): Record<string, string> => ({
  'package.json': JSON.stringify(
    {
      name: 'warehouse-service',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'Tiny warehouse inventory + order service used as an agent eval fixture.',
      scripts: {
        test: 'node --test test/',
      },
    },
    null,
    2,
  ),
  'README.md':
    '# warehouse-service\n\n' +
    'A small inventory and order-pricing service.\n\n' +
    '- `src/inventory.mjs` tracks SKU stock levels and reservations.\n' +
    '- `src/pricing.mjs` computes order totals with tiered discounts.\n' +
    '- `src/orders.mjs` ties stock reservation and pricing together.\n' +
    '- `service/forecast.py` is an auxiliary demand-forecast helper.\n',
  '.gitignore': 'node_modules/\ngraphify-out/\n',
  'src/inventory.mjs':
    '// In-memory inventory ledger keyed by SKU.\n' +
    'export class Inventory {\n' +
    '  constructor() {\n' +
    '    this.stock = new Map();\n' +
    '  }\n\n' +
    '  receive(sku, qty) {\n' +
    '    this.stock.set(sku, (this.stock.get(sku) ?? 0) + qty);\n' +
    '  }\n\n' +
    '  available(sku) {\n' +
    '    return this.stock.get(sku) ?? 0;\n' +
    '  }\n\n' +
    '  // Reserve stock for an order. Must refuse to oversell.\n' +
    '  reserve(sku, qty) {\n' +
    (withBug
      ? '    // BUG: does not check availability before decrementing, so it oversells.\n' +
        '    this.stock.set(sku, this.available(sku) - qty);\n' +
        '    return true;\n'
      : '    if (qty > this.available(sku)) return false;\n' +
        '    this.stock.set(sku, this.available(sku) - qty);\n' +
        '    return true;\n') +
    '  }\n' +
    '}\n',
  'src/pricing.mjs':
    '// Tiered discount pricing for an order line total.\n' +
    'export function lineTotal(unitPrice, qty) {\n' +
    '  return unitPrice * qty;\n' +
    '}\n\n' +
    'export function discountRate(subtotal) {\n' +
    '  if (subtotal >= 1000) return 0.15;\n' +
    '  if (subtotal >= 500) return 0.1;\n' +
    '  if (subtotal >= 100) return 0.05;\n' +
    '  return 0;\n' +
    '}\n\n' +
    'export function orderTotal(lines) {\n' +
    '  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line.unitPrice, line.qty), 0);\n' +
    '  return subtotal * (1 - discountRate(subtotal));\n' +
    '}\n',
  'src/orders.mjs':
    "import { Inventory } from './inventory.mjs';\n" +
    "import { orderTotal } from './pricing.mjs';\n\n" +
    'export function placeOrder(inventory, lines) {\n' +
    '  for (const line of lines) {\n' +
    '    if (!inventory.reserve(line.sku, line.qty)) {\n' +
    "      return { ok: false, reason: `insufficient stock for ${line.sku}` };\n" +
    '    }\n' +
    '  }\n' +
    '  return { ok: true, total: orderTotal(lines) };\n' +
    '}\n',
  'test/inventory.test.mjs':
    "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { Inventory } from '../src/inventory.mjs';\n" +
    "import { placeOrder } from '../src/orders.mjs';\n\n" +
    "test('reserve refuses to oversell', () => {\n" +
    '  const inv = new Inventory();\n' +
    "  inv.receive('A', 5);\n" +
    "  assert.equal(inv.reserve('A', 10), false);\n" +
    "  assert.equal(inv.available('A'), 5);\n" +
    '});\n\n' +
    "test('placeOrder rejects an oversized line', () => {\n" +
    '  const inv = new Inventory();\n' +
    "  inv.receive('B', 2);\n" +
    "  const result = placeOrder(inv, [{ sku: 'B', qty: 3, unitPrice: 50 }]);\n" +
    '  assert.equal(result.ok, false);\n' +
    '});\n',
  'service/forecast.py':
    '"""Simple moving-average demand forecast helper."""\n\n\n' +
    'def moving_average(history, window):\n' +
    '    if window <= 0:\n' +
    '        raise ValueError("window must be positive")\n' +
    '    if len(history) < window:\n' +
    '        return sum(history) / len(history) if history else 0.0\n' +
    '    recent = history[-window:]\n' +
    '    return sum(recent) / window\n\n\n' +
    'def reorder_point(history, window, lead_time):\n' +
    '    return moving_average(history, window) * lead_time\n',
});

export function createFixture(options: FixtureOptions): string {
  rmSync(options.root, { recursive: true, force: true });
  mkdirSync(options.root, { recursive: true });

  for (const [relative, content] of Object.entries(FILES(options.withBug))) {
    const target = path.join(options.root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  if (options.git) {
    const run = (args: string[]) => execFileSync('git', args, { cwd: options.root, stdio: 'ignore' });
    run(['init', '-q']);
    run(['config', 'user.email', 'agent-eval@codoptic.local']);
    run(['config', 'user.name', 'Agent Eval']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'seed warehouse-service fixture']);
  }

  return options.root;
}

export function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
