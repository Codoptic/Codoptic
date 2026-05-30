import { describe, expect, it } from 'vitest';
import { deriveStructuralSignals } from '../repo/repoContext';

describe('deriveStructuralSignals', () => {
  it('weights central files by import degree, strongest first', () => {
    const signals = deriveStructuralSignals({
      centralFiles: [
        { path: 'lib/hub.ts', incoming: 20, outgoing: 10, externalDeps: [] },
        { path: 'lib/leaf.ts', incoming: 1, outgoing: 0, externalDeps: [] },
        { path: 'lib/isolated.ts', incoming: 0, outgoing: 0, externalDeps: [] },
      ],
      routes: [],
    });

    expect(signals[0]?.path).toBe('lib/hub.ts');
    expect(signals[0]?.weight).toBe(90);
    // Peripheral file gets a much smaller weight than the hub.
    const leaf = signals.find((signal) => signal.path === 'lib/leaf.ts');
    expect(leaf && leaf.weight).toBeLessThan(90);
    // Files with zero import degree contribute no signal.
    expect(signals.some((signal) => signal.path === 'lib/isolated.ts')).toBe(false);
  });

  it('emits route signals with method metadata', () => {
    const signals = deriveStructuralSignals({
      centralFiles: [],
      routes: [{ path: 'app/api/orders/route.ts', route: '/orders', methods: ['GET', 'POST'] }],
    });
    const route = signals.find((signal) => signal.path === 'app/api/orders/route.ts');
    expect(route).toBeDefined();
    expect(route?.weight).toBe(60);
    expect(route?.reason).toContain('GET,POST');
  });

  it('keeps the highest weight when a file is both central and a route', () => {
    const signals = deriveStructuralSignals({
      centralFiles: [{ path: 'app/api/x/route.ts', incoming: 5, outgoing: 5, externalDeps: [] }],
      routes: [{ path: 'app/api/x/route.ts', route: '/x', methods: [] }],
    });
    const entry = signals.find((signal) => signal.path === 'app/api/x/route.ts');
    // central weight (90, sole central file) beats the flat route weight (60).
    expect(entry?.weight).toBe(90);
  });
});
