'use strict';
/**
 * Dual-party (participant-based) authorization for trade resources that span
 * a buyer org + a seller org (deals, deal-room messages, quotations). Access is
 * granted to members of either participant org, or to platform admins.
 */
const { Op } = require('sequelize');

// Platform-admin roles get unrestricted (cross-participant) visibility — identical to the
// tenant-isolation bypass set in tenantContext.js / collectionController.js. The gateway maps
// canonical identity to req.auth with both a scalar `role` (highest) and a `roles[]` array;
// check both so an 'owner'/'super_admin' caller (whose scalar role isn't literally 'admin') is
// still treated as a platform admin.
const ADMIN_ROLES = new Set(['admin', 'owner', 'super_admin']);
const isAdmin = (req) => {
    const a = req && req.auth;
    if (!a) return false;
    if (a.role && ADMIN_ROLES.has(a.role)) return true;
    return Array.isArray(a.roles) && a.roles.some((r) => ADMIN_ROLES.has(r));
};
const callerOrg = (req) => (req.auth && (req.auth.orgCode || req.auth.orgId)) || null;

// Sequelize WHERE limiting Deals to the caller's participant orgs.
// admin -> unrestricted; authed-without-org -> impossible match (sees nothing).
const dealWhereForCaller = (req) => {
    if (isAdmin(req)) return {};
    const org = callerOrg(req);
    if (!org) return { id: -1 };
    return { [Op.or]: [{ buyer_org_id: org }, { seller_org_id: org }] };
};

const isDealParticipant = (req, deal) => isAdmin(req)
    || (!!deal && (deal.buyer_org_id === callerOrg(req) || deal.seller_org_id === callerOrg(req)));

module.exports = { isAdmin, callerOrg, dealWhereForCaller, isDealParticipant };
