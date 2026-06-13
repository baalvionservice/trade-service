'use strict';
/**
 * War Room 3 — unit tests for the financial authorization controls.
 * Pure-logic (no DB): tenant ownership, dual-control threshold, and the
 * maker-checker state machine used by escrow release/refund + wallet debit.
 */
const {
    MONEY_ROLES,
    hasPlatformBypass,
    assertTenantOwnership,
    requiresDualApproval,
    thresholdFor,
    evaluateDualControl,
} = require('../utils/financialControls');

const reqWith = (roles, tenantId, userId = 'u1') => ({
    auth: { roles, tenantId, orgId: tenantId, userId },
});

describe('financialControls — tenant ownership', () => {
    test('platform operator bypasses tenant ownership', () => {
        const req = reqWith(['platform_admin'], 'T-A');
        expect(hasPlatformBypass(req)).toBe(true);
        expect(assertTenantOwnership({ tenant_id: 'T-B' }, req)).toBe(true);
    });

    test('org admin is tenant-scoped — cannot touch another tenant record', () => {
        const req = reqWith(['admin'], 'T-A');
        expect(hasPlatformBypass(req)).toBe(false);
        expect(() => assertTenantOwnership({ tenant_id: 'T-B' }, req)).toThrow();
    });

    test('org admin may act within its own tenant', () => {
        const req = reqWith(['owner'], 'T-A');
        expect(assertTenantOwnership({ tenant_id: 'T-A' }, req)).toBe(true);
    });

    test('money roles do not include viewer/member/client', () => {
        expect(MONEY_ROLES).toEqual(['admin', 'owner', 'super_admin']);
        expect(MONEY_ROLES).not.toContain('viewer');
        expect(MONEY_ROLES).not.toContain('member');
        expect(MONEY_ROLES).not.toContain('client');
    });
});

describe('financialControls — dual-control threshold', () => {
    const prev = { ...process.env };
    afterEach(() => { process.env = { ...prev }; });

    test('uses the configured per-currency threshold', () => {
        process.env.APPROVAL_THRESHOLD_USD = '250000';
        expect(thresholdFor('USD')).toBe(250000);
        expect(requiresDualApproval(250000, 'USD')).toBe(true);
        expect(requiresDualApproval(249999, 'USD')).toBe(false);
    });

    test('falls back to the default threshold', () => {
        delete process.env.APPROVAL_THRESHOLD_USD;
        delete process.env.APPROVAL_THRESHOLD_DEFAULT;
        expect(thresholdFor('USD')).toBe(1000000);
        expect(requiresDualApproval(1000001, 'USD')).toBe(true);
        expect(requiresDualApproval(500, 'USD')).toBe(false);
    });
});

describe('financialControls — maker-checker state machine', () => {
    const prev = { ...process.env };
    beforeEach(() => { process.env.APPROVAL_THRESHOLD_DEFAULT = '100000'; });
    afterEach(() => { process.env = { ...prev }; });

    test('below threshold executes immediately', () => {
        const out = evaluateDualControl({
            state: {}, amount: 50000, currency: 'USD', action: 'release', req: reqWith(['admin'], 'T-A', 'maker'),
        });
        expect(out.decision).toBe('execute');
    });

    test('first large request awaits a second approver (money does not move)', () => {
        const out = evaluateDualControl({
            state: {}, amount: 500000, currency: 'USD', action: 'release', req: reqWith(['admin'], 'T-A', 'maker'),
        });
        expect(out.decision).toBe('await_approval');
        expect(out.nextState.dual_control.requested_by).toBe('maker');
    });

    test('the same user cannot approve their own request', () => {
        const state = { dual_control: { action: 'release', requested_by: 'maker', requested_at: 'x' } };
        expect(() => evaluateDualControl({
            state, amount: 500000, currency: 'USD', action: 'release', req: reqWith(['admin'], 'T-A', 'maker'),
        })).toThrow(/different authorized user/i);
    });

    test('a distinct authorized approver executes the release', () => {
        const state = { dual_control: { action: 'release', requested_by: 'maker', requested_at: 'x' } };
        const out = evaluateDualControl({
            state, amount: 500000, currency: 'USD', action: 'release', req: reqWith(['owner'], 'T-A', 'checker'),
        });
        expect(out.decision).toBe('execute');
        expect(out.nextState.dual_control.approved_by).toBe('checker');
    });
});
