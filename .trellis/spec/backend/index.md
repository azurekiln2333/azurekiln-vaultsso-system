# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [Account Bindings](./account-bindings.md) | Phone editing and Huawei app identity contracts | Defined |
| [Proxy Addresses](./proxy-addresses.md) | Local reverse proxy trust and client IP recording | Defined |
| [Deployment](./deployment.md) | Non-root container runtime, persisted secrets/assets, scoped updates and gated GitHub/CNB images | Defined |
| [Password Verification](./password-verification.md) | Dedicated login MFA and on-demand CAPTCHA | Defined |
| [User Applications](./user-applications.md) | Durable app usage and personal/admin app lists | Defined |
| [Multiple Authenticators](./multiple-authenticators.md) | Independent TOTP devices, lifecycle locks and final credential issuance | Defined |
| [User Import](./user-import.md) | Direct file uploads, scoped body limits and per-row duplicate results | Defined |
| [Registration Policy](./registration-policy.md) | Registration-only ASCII usernames, proof boundaries, configured password guidance and QFLI email-registration closure | Defined |
| [Session Duration](./session-duration.md) | Fixed 1/7/14-day browser login, continuation, legacy caps and credential replacement | Defined |
| [Account Erasure](./account-erasure.md) | QFLI service-client erasure, permanent tombstones, atomic revocation and pseudonymized retained logs | Defined |
| [Profile Moderation](./moderation.md) | SDK boundary for profile text, safe failures and disabled manual avatar input | Defined |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
