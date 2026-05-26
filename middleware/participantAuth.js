'use strict';
/**
 * Dual-party (participant-based) authorization for trade resources that span
 * a buyer org + a seller org (deals, deal-room messages, quotations). Access is
 * granted to members of either participant org, or to platform admins.
 */
const { Op } = require('sequelize');

const isAdmin = (req) => req.auth && req.auth.role === 'admin';
const callerOrg = (req) => (req.auth && req.auth.orgCode) || null;

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
