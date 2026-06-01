<div align="center">

# Baalvion Trade Service

**Backend API for the Baalvion Global Trade Operating System**

[![Trade OS](https://img.shields.io/badge/Trade_OS-Live-36E0C4?style=flat-square)](https://market.baalvion.com)
[![Website](https://img.shields.io/badge/baalvion.com-0A0E27?style=flat-square&logo=googlechrome&logoColor=5B8CFF)](https://baalvion.com)
[![License](https://img.shields.io/badge/license-Proprietary-1E1147?style=flat-square)](./LICENSE)

</div>

---

## Overview

`trade-service` is the backend that powers the **Baalvion Global Trade OS** — the platform for
cross-border trade execution, finance, compliance, and logistics. It exposes the REST APIs behind
the [market.baalvion.com](https://market.baalvion.com) experience.

## ✨ Capabilities

- **Marketplace & RFQ** — listings, requests for quote, and quote management
- **Trade execution** — orders, deals, and document workflows
- **Logistics** — freight, shipment, customs, and document tracking
- **Trade finance** — integration points for financing, escrow, and settlement
- **Secure by default** — centralized RS256 identity and tenant-aware data access

## 🧱 Tech stack

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white)
![Sequelize](https://img.shields.io/badge/Sequelize-52B0E7?style=flat-square&logo=sequelize&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![JWT](https://img.shields.io/badge/JWT_RS256-000000?style=flat-square&logo=jsonwebtokens&logoColor=white)

## 🚀 Getting started

```bash
# install dependencies
npm install

# configure environment
cp .env.example .env   # set DATABASE_URL, JWT public key, etc.

# run the development server
npm run dev
```

> Requires Node.js and a PostgreSQL database. Authentication verifies tokens issued by the
> platform's centralized RS256 identity service — do not introduce a second issuer.

## 🌐 Part of the Baalvion ecosystem

Built and operated by **Baalvion Industries Private Limited**.
Explore the full platform → [baalvion.com](https://baalvion.com) · [@baalvionservice](https://github.com/baalvionservice)

## 📜 License

Proprietary. © 2025–2026 Baalvion Industries Private Limited. All rights reserved. See [LICENSE](./LICENSE).
