--
-- PostgreSQL database dump
--

-- NOTE: the pg_dump \restrict / \unrestrict psql meta-commands were removed —
-- they are psql-client directives, not SQL, and crash the migrate.js runner
-- (sequelize.query) on a clean rebuild. Removing them is schema-neutral.

-- Dumped from database version 15.18
-- Dumped by pg_dump version 15.18

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: trade; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: enum_compliance_cases_case_type; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_compliance_cases_case_type AS ENUM (
    'sanctions_check',
    'kyc_review',
    'aml_screening',
    'customs_violation',
    'trade_restriction'
);


--
-- Name: enum_compliance_cases_risk_level; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_compliance_cases_risk_level AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: enum_compliance_cases_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_compliance_cases_status AS ENUM (
    'open',
    'under_review',
    'cleared',
    'escalated',
    'closed'
);


--
-- Name: enum_deals_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_deals_status AS ENUM (
    'draft',
    'negotiation',
    'finalized',
    'committed',
    'cancelled'
);


--
-- Name: enum_disputes_dispute_type; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_disputes_dispute_type AS ENUM (
    'quality',
    'delivery',
    'payment',
    'documentation',
    'other'
);


--
-- Name: enum_disputes_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_disputes_status AS ENUM (
    'open',
    'evidence_collection',
    'mediation',
    'arbitration',
    'resolved',
    'closed'
);


--
-- Name: enum_documents_doc_type; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_documents_doc_type AS ENUM (
    'invoice',
    'bill_of_lading',
    'certificate_of_origin',
    'packing_list',
    'letter_of_credit',
    'inspection_report',
    'customs_declaration',
    'insurance_certificate',
    'other'
);


--
-- Name: enum_documents_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_documents_status AS ENUM (
    'draft',
    'issued',
    'verified',
    'rejected',
    'expired'
);


--
-- Name: enum_escrows_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_escrows_status AS ENUM (
    'pending',
    'funded',
    'released',
    'refunded',
    'disputed'
);


--
-- Name: enum_marketplace_listings_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_marketplace_listings_status AS ENUM (
    'active',
    'draft',
    'archived'
);


--
-- Name: enum_marketplace_listings_type; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_marketplace_listings_type AS ENUM (
    'offer',
    'request'
);


--
-- Name: enum_orders_fulfillment_state; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_orders_fulfillment_state AS ENUM (
    'pending',
    'production',
    'shipped',
    'delivered'
);


--
-- Name: enum_orders_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_orders_status AS ENUM (
    'pending',
    'confirmed',
    'in_production',
    'shipped',
    'delivered',
    'cancelled'
);


--
-- Name: enum_organizations_kyc_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_organizations_kyc_status AS ENUM (
    'pending',
    'verified',
    'rejected'
);


--
-- Name: enum_organizations_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_organizations_status AS ENUM (
    'active',
    'suspended',
    'pending'
);


--
-- Name: enum_organizations_type; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_organizations_type AS ENUM (
    'buyer',
    'seller',
    'carrier',
    'bank',
    'insurer',
    'regulator'
);


--
-- Name: enum_payments_method; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_payments_method AS ENUM (
    'wire_transfer',
    'letter_of_credit',
    'escrow',
    'open_account'
);


--
-- Name: enum_payments_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_payments_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed',
    'refunded'
);


--
-- Name: enum_quotations_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_quotations_status AS ENUM (
    'pending',
    'accepted',
    'rejected'
);


--
-- Name: enum_rfqs_incoterm; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_rfqs_incoterm AS ENUM (
    'EXW',
    'FOB',
    'CIF',
    'DDP',
    'DAP',
    'FCA'
);


--
-- Name: enum_rfqs_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_rfqs_status AS ENUM (
    'draft',
    'open',
    'closed',
    'awarded',
    'cancelled'
);


--
-- Name: enum_shipments_status; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_shipments_status AS ENUM (
    'booked',
    'picked_up',
    'in_transit',
    'port_processing',
    'customs_clearance',
    'customs_hold',
    'released',
    'delivered',
    'delayed',
    're_routed',
    'cancelled'
);


--
-- Name: enum_users_role; Type: TYPE; Schema: trade; Owner: -
--

CREATE TYPE trade.enum_users_role AS ENUM (
    'admin',
    'operator',
    'client'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.audit_logs (
    id uuid NOT NULL,
    seq integer NOT NULL,
    "tenantId" character varying(64) DEFAULT 'T-DEMO'::character varying,
    "actorId" character varying(255),
    action character varying(255),
    "resourceType" character varying(255),
    "resourceId" character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb,
    "createdAt" character varying(40),
    "prevHash" character varying(64),
    hash character varying(64)
);


--
-- Name: audit_logs_seq_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.audit_logs_seq_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_seq_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.audit_logs_seq_seq OWNED BY trade.audit_logs.seq;


--
-- Name: chat_messages; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.chat_messages (
    id uuid NOT NULL,
    "tenantId" character varying(255) DEFAULT 'T-DEMO'::character varying NOT NULL,
    "dealId" character varying(255) NOT NULL,
    sender character varying(255) DEFAULT 'system'::character varying,
    "senderName" character varying(255),
    content text,
    type character varying(255) DEFAULT 'text'::character varying,
    "offerData" jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: collections; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.collections (
    id uuid NOT NULL,
    "tenantId" character varying(255) DEFAULT 'T-DEMO'::character varying,
    collection character varying(120) NOT NULL,
    data jsonb DEFAULT '{}'::jsonb,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: compliance_cases; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.compliance_cases (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    entity_type character varying(100),
    entity_id text,
    case_type trade.enum_compliance_cases_case_type DEFAULT 'kyc_review'::trade.enum_compliance_cases_case_type,
    status trade.enum_compliance_cases_status DEFAULT 'open'::trade.enum_compliance_cases_status,
    risk_level trade.enum_compliance_cases_risk_level DEFAULT 'low'::trade.enum_compliance_cases_risk_level,
    assigned_to text,
    findings text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: compliance_cases_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.compliance_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: compliance_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.compliance_cases_id_seq OWNED BY trade.compliance_cases.id;


--
-- Name: deals; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.deals (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    rfq_id text,
    buyer_org_id text,
    seller_org_id text,
    commodity character varying(255),
    quantity numeric(15,4),
    unit character varying(50),
    unit_price numeric(15,4),
    total_value numeric(20,2),
    currency character varying(10) DEFAULT 'USD'::character varying,
    incoterm character varying(10),
    origin character varying(255),
    destination character varying(255),
    payment_terms character varying(255),
    status trade.enum_deals_status DEFAULT 'draft'::trade.enum_deals_status,
    signed_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_message text
);


--
-- Name: deals_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.deals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deals_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.deals_id_seq OWNED BY trade.deals.id;


--
-- Name: disputes; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.disputes (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    order_id integer,
    claimant_org_id text,
    respondent_org_id text,
    dispute_type trade.enum_disputes_dispute_type DEFAULT 'other'::trade.enum_disputes_dispute_type,
    description text,
    status trade.enum_disputes_status DEFAULT 'open'::trade.enum_disputes_status,
    resolution text,
    resolved_at timestamp with time zone,
    evidence jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: disputes_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.disputes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.disputes_id_seq OWNED BY trade.disputes.id;


--
-- Name: documents; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.documents (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    entity_type character varying(100),
    entity_id text,
    doc_type character varying(64),
    title character varying(255),
    file_url text,
    file_hash text,
    issuer_org_id text,
    status character varying(32) DEFAULT 'draft'::character varying,
    issued_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    classification character varying(32) DEFAULT 'OPERATIONAL'::character varying,
    version integer DEFAULT 1,
    company_id text,
    uploaded_by text,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.documents_id_seq OWNED BY trade.documents.id;


--
-- Name: escrows; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.escrows (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    order_id integer,
    buyer_org_id text,
    seller_org_id text,
    amount numeric(20,2),
    currency character varying(10),
    status trade.enum_escrows_status DEFAULT 'pending'::trade.enum_escrows_status,
    funded_at timestamp with time zone,
    released_at timestamp with time zone,
    release_conditions jsonb DEFAULT '{}'::jsonb,
    mandate_hash text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: escrows_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.escrows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: escrows_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.escrows_id_seq OWNED BY trade.escrows.id;


--
-- Name: marketplace_listings; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.marketplace_listings (
    id uuid NOT NULL,
    "tenantId" character varying(255) DEFAULT 'T-DEMO'::character varying NOT NULL,
    "companyId" character varying(255) DEFAULT 'COMP-101'::character varying NOT NULL,
    "companyName" character varying(255) DEFAULT 'Institutional Partner'::character varying,
    type trade.enum_marketplace_listings_type DEFAULT 'offer'::trade.enum_marketplace_listings_type,
    title character varying(255) NOT NULL,
    description text,
    category character varying(120),
    "trustScore" integer DEFAULT 750,
    "isVerified" boolean DEFAULT true,
    "hsCode" character varying(32),
    "originCountry" character varying(120),
    unit character varying(40) DEFAULT 'unit'::character varying,
    currency character varying(8) DEFAULT 'USD'::character varying,
    "basePrice" double precision,
    "marketAveragePrice" double precision,
    moq integer,
    "leadTime" character varying(60),
    "sellerTier" character varying(40) DEFAULT 'Verified'::character varying,
    incoterms jsonb DEFAULT '[]'::jsonb,
    "paymentTerms" jsonb DEFAULT '[]'::jsonb,
    certifications jsonb DEFAULT '[]'::jsonb,
    "pricingTiers" jsonb DEFAULT '[]'::jsonb,
    status trade.enum_marketplace_listings_status DEFAULT 'active'::trade.enum_marketplace_listings_status,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.notifications (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    recipient_org_id text,
    type character varying(100),
    title character varying(255),
    message text,
    entity_type character varying(100),
    entity_id text,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.notifications_id_seq OWNED BY trade.notifications.id;


--
-- Name: orders; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.orders (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    deal_id text,
    buyer_org_id text,
    seller_org_id text,
    product character varying(255),
    quantity numeric(15,4),
    price numeric(15,4),
    total_value numeric(20,2),
    currency character varying(10) DEFAULT 'USD'::character varying,
    status trade.enum_orders_status DEFAULT 'pending'::trade.enum_orders_status,
    fulfillment_state trade.enum_orders_fulfillment_state DEFAULT 'pending'::trade.enum_orders_fulfillment_state,
    logistics_id text,
    due_date timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.orders_id_seq OWNED BY trade.orders.id;


--
-- Name: organizations; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.organizations (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text NOT NULL,
    name character varying(255) NOT NULL,
    type trade.enum_organizations_type,
    country character varying(100),
    registration_number character varying(100),
    status trade.enum_organizations_status DEFAULT 'pending'::trade.enum_organizations_status,
    contact_email character varying(255),
    kyc_status trade.enum_organizations_kyc_status DEFAULT 'pending'::trade.enum_organizations_kyc_status,
    risk_score numeric(5,2),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    code character varying(64)
);


--
-- Name: organizations_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.organizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organizations_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.organizations_id_seq OWNED BY trade.organizations.id;


--
-- Name: payments; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.payments (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    order_id integer,
    payer_org_id text,
    payee_org_id text,
    amount numeric(20,2),
    currency character varying(10),
    method trade.enum_payments_method DEFAULT 'wire_transfer'::trade.enum_payments_method,
    status trade.enum_payments_status DEFAULT 'pending'::trade.enum_payments_status,
    provider_tx_id text,
    settled_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.payments_id_seq OWNED BY trade.payments.id;


--
-- Name: quotations; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.quotations (
    id uuid NOT NULL,
    "tenantId" character varying(255) DEFAULT 'T-DEMO'::character varying NOT NULL,
    "rfqId" character varying(255) NOT NULL,
    "sellerId" character varying(255) DEFAULT 'COMP-102'::character varying,
    "sellerName" character varying(255) DEFAULT 'Institutional Seller'::character varying,
    price double precision,
    quantity double precision,
    currency character varying(8) DEFAULT 'USD'::character varying,
    "deliveryTime" character varying(255),
    message text,
    "trustScore" integer DEFAULT 820,
    status trade.enum_quotations_status DEFAULT 'pending'::trade.enum_quotations_status,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: rfqs; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.rfqs (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    buyer_org_id integer,
    title character varying(255),
    commodity character varying(255),
    quantity numeric(15,4),
    unit character varying(50),
    origin_country character varying(100),
    destination_country character varying(100),
    incoterm trade.enum_rfqs_incoterm,
    required_delivery_date date,
    budget_usd numeric(15,2),
    status trade.enum_rfqs_status DEFAULT 'open'::trade.enum_rfqs_status,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    product_name character varying(255),
    category character varying(120),
    description text,
    target_price numeric(15,2),
    currency character varying(8) DEFAULT 'USD'::character varying
);


--
-- Name: rfqs_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.rfqs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rfqs_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.rfqs_id_seq OWNED BY trade.rfqs.id;


--
-- Name: shipments; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.shipments (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    order_id integer,
    carrier_id text,
    carrier_name character varying(255),
    tracking_number character varying(255),
    vessel_name character varying(255),
    container_id character varying(100),
    origin character varying(255),
    destination character varying(255),
    status trade.enum_shipments_status DEFAULT 'booked'::trade.enum_shipments_status,
    estimated_arrival timestamp with time zone,
    actual_arrival timestamp with time zone,
    value numeric(20,2),
    currency character varying(10),
    milestones jsonb DEFAULT '[]'::jsonb,
    exceptions jsonb DEFAULT '[]'::jsonb,
    iot_stream_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: shipments_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.shipments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shipments_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.shipments_id_seq OWNED BY trade.shipments.id;


--
-- Name: users; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    password_hash text NOT NULL,
    full_name character varying(255) DEFAULT ''::character varying,
    role trade.enum_users_role DEFAULT 'operator'::trade.enum_users_role,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    tenant_id character varying(64) DEFAULT 'T-DEMO'::character varying NOT NULL,
    mfa_enabled boolean DEFAULT false,
    mfa_secret text,
    mfa_backup_codes jsonb DEFAULT '[]'::jsonb,
    org_code character varying(64)
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.users_id_seq OWNED BY trade.users.id;


--
-- Name: wallets; Type: TABLE; Schema: trade; Owner: -
--

CREATE TABLE trade.wallets (
    id integer NOT NULL,
    tenant_id text DEFAULT 'T-DEMO'::text,
    org_id integer NOT NULL,
    balance numeric(20,6) DEFAULT 0,
    reserved_balance numeric(20,6) DEFAULT 0,
    currency character varying(10) DEFAULT 'USD'::character varying,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: wallets_id_seq; Type: SEQUENCE; Schema: trade; Owner: -
--

CREATE SEQUENCE trade.wallets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallets_id_seq; Type: SEQUENCE OWNED BY; Schema: trade; Owner: -
--

ALTER SEQUENCE trade.wallets_id_seq OWNED BY trade.wallets.id;


--
-- Name: audit_logs seq; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.audit_logs ALTER COLUMN seq SET DEFAULT nextval('trade.audit_logs_seq_seq'::regclass);


--
-- Name: compliance_cases id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.compliance_cases ALTER COLUMN id SET DEFAULT nextval('trade.compliance_cases_id_seq'::regclass);


--
-- Name: deals id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.deals ALTER COLUMN id SET DEFAULT nextval('trade.deals_id_seq'::regclass);


--
-- Name: disputes id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.disputes ALTER COLUMN id SET DEFAULT nextval('trade.disputes_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.documents ALTER COLUMN id SET DEFAULT nextval('trade.documents_id_seq'::regclass);


--
-- Name: escrows id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.escrows ALTER COLUMN id SET DEFAULT nextval('trade.escrows_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.notifications ALTER COLUMN id SET DEFAULT nextval('trade.notifications_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.orders ALTER COLUMN id SET DEFAULT nextval('trade.orders_id_seq'::regclass);


--
-- Name: organizations id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.organizations ALTER COLUMN id SET DEFAULT nextval('trade.organizations_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.payments ALTER COLUMN id SET DEFAULT nextval('trade.payments_id_seq'::regclass);


--
-- Name: rfqs id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.rfqs ALTER COLUMN id SET DEFAULT nextval('trade.rfqs_id_seq'::regclass);


--
-- Name: shipments id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.shipments ALTER COLUMN id SET DEFAULT nextval('trade.shipments_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.users ALTER COLUMN id SET DEFAULT nextval('trade.users_id_seq'::regclass);


--
-- Name: wallets id; Type: DEFAULT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.wallets ALTER COLUMN id SET DEFAULT nextval('trade.wallets_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_seq_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.audit_logs
    ADD CONSTRAINT audit_logs_seq_key UNIQUE (seq);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: collections collections_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: compliance_cases compliance_cases_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.compliance_cases
    ADD CONSTRAINT compliance_cases_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: escrows escrows_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.escrows
    ADD CONSTRAINT escrows_pkey PRIMARY KEY (id);


--
-- Name: marketplace_listings marketplace_listings_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.marketplace_listings
    ADD CONSTRAINT marketplace_listings_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_code_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.organizations
    ADD CONSTRAINT organizations_code_key UNIQUE (code);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payments payments_provider_tx_id_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.payments
    ADD CONSTRAINT payments_provider_tx_id_key UNIQUE (provider_tx_id);


--
-- Name: quotations quotations_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.quotations
    ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);


--
-- Name: rfqs rfqs_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.rfqs
    ADD CONSTRAINT rfqs_pkey PRIMARY KEY (id);


--
-- Name: shipments shipments_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.shipments
    ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);


--
-- Name: shipments shipments_tracking_number_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.shipments
    ADD CONSTRAINT shipments_tracking_number_key UNIQUE (tracking_number);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_org_id_key; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.wallets
    ADD CONSTRAINT wallets_org_id_key UNIQUE (org_id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);


--
-- Name: collections_collection; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX collections_collection ON trade.collections USING btree (collection);


--
-- Name: idx_audit_seq; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_audit_seq ON trade.audit_logs USING btree (seq);


--
-- Name: idx_collections_tenant_coll; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_collections_tenant_coll ON trade.collections USING btree ("tenantId", collection);


--
-- Name: idx_compliance_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_compliance_tenant ON trade.compliance_cases USING btree (tenant_id);


--
-- Name: idx_deals_rfq; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_deals_rfq ON trade.deals USING btree (rfq_id);


--
-- Name: idx_deals_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_deals_tenant ON trade.deals USING btree (tenant_id);


--
-- Name: idx_disputes_order; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_disputes_order ON trade.disputes USING btree (order_id);


--
-- Name: idx_disputes_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_disputes_tenant ON trade.disputes USING btree (tenant_id);


--
-- Name: idx_documents_entity; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_documents_entity ON trade.documents USING btree (entity_type, entity_id);


--
-- Name: idx_documents_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_documents_tenant ON trade.documents USING btree (tenant_id);


--
-- Name: idx_escrows_order; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_escrows_order ON trade.escrows USING btree (order_id);


--
-- Name: idx_escrows_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_escrows_tenant ON trade.escrows USING btree (tenant_id);


--
-- Name: idx_listings_company; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_listings_company ON trade.marketplace_listings USING btree ("companyId");


--
-- Name: idx_listings_tenant_status; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_listings_tenant_status ON trade.marketplace_listings USING btree ("tenantId", status);


--
-- Name: idx_messages_tenant_deal; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_messages_tenant_deal ON trade.chat_messages USING btree ("tenantId", "dealId");


--
-- Name: idx_notifications_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_notifications_tenant ON trade.notifications USING btree (tenant_id);


--
-- Name: idx_orders_deal; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_orders_deal ON trade.orders USING btree (deal_id);


--
-- Name: idx_orders_tenant_status; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_orders_tenant_status ON trade.orders USING btree (tenant_id, status);


--
-- Name: idx_orgs_code; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_orgs_code ON trade.organizations USING btree (code);


--
-- Name: idx_orgs_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_orgs_tenant ON trade.organizations USING btree (tenant_id);


--
-- Name: idx_payments_order; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_payments_order ON trade.payments USING btree (order_id);


--
-- Name: idx_payments_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_payments_tenant ON trade.payments USING btree (tenant_id);


--
-- Name: idx_quotations_tenant_rfq; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_quotations_tenant_rfq ON trade.quotations USING btree ("tenantId", "rfqId");


--
-- Name: idx_rfqs_created; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_rfqs_created ON trade.rfqs USING btree (created_at);


--
-- Name: idx_rfqs_tenant_status; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_rfqs_tenant_status ON trade.rfqs USING btree (tenant_id, status);


--
-- Name: idx_shipments_order; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_shipments_order ON trade.shipments USING btree (order_id);


--
-- Name: idx_shipments_tenant_status; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_shipments_tenant_status ON trade.shipments USING btree (tenant_id, status);


--
-- Name: idx_wallets_tenant; Type: INDEX; Schema: trade; Owner: -
--

CREATE INDEX idx_wallets_tenant ON trade.wallets USING btree (tenant_id);


--
-- Name: disputes disputes_order_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.disputes
    ADD CONSTRAINT disputes_order_id_fkey FOREIGN KEY (order_id) REFERENCES trade.orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: escrows escrows_order_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.escrows
    ADD CONSTRAINT escrows_order_id_fkey FOREIGN KEY (order_id) REFERENCES trade.orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES trade.orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: rfqs rfqs_buyer_org_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.rfqs
    ADD CONSTRAINT rfqs_buyer_org_id_fkey FOREIGN KEY (buyer_org_id) REFERENCES trade.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: shipments shipments_order_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.shipments
    ADD CONSTRAINT shipments_order_id_fkey FOREIGN KEY (order_id) REFERENCES trade.orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: wallets wallets_org_id_fkey; Type: FK CONSTRAINT; Schema: trade; Owner: -
--

ALTER TABLE ONLY trade.wallets
    ADD CONSTRAINT wallets_org_id_fkey FOREIGN KEY (org_id) REFERENCES trade.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
-- (\unrestrict psql meta-command removed — see note at top of file.)

