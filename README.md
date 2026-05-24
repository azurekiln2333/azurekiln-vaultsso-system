# AzureKiln OAuth2

Standalone OAuth2 and OpenID Connect provider extracted from the OAuth2 portion of the original workspace.

## Features

- Authorization Code Grant with signed access tokens, refresh tokens, and ID tokens
- Client Credentials Grant
- Refresh Token Grant
- OpenID discovery at `/.well-known/openid-configuration`
- UserInfo, token introspection, and token revocation endpoints
- MySQL-backed users, clients, auth codes, access tokens, and refresh tokens
- Login, registration, profile, application management, token audit, success, and error pages
- Admin-only client and token management pages
- Tailwind-based UI matching the existing VaultSSO demo pages

## Quick Start

```bash
cd azurekiln-oauth2
npm install
```

Create the database:

```sql
CREATE DATABASE vaultsso_oauth2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Create `.env` from `.env.example` and update the MySQL credentials:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=vaultsso_oauth2
PORT=3146
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3146
JWT_SECRET=replace-this-with-a-long-random-secret
TOKEN_EXPIRY=1h
REFRESH_TOKEN_EXPIRY=7d
```

Initialize demo data:

```bash
npm run init-db
```

Start the server:

```bash
npm start
```

Open `http://localhost:3146/oauth2/authorize`.

## Demo Data

Demo admin user:

- Username: `demo@vaultsso.com`
- Password: `demo123`

Seeded clients:

- `salesforce-prod` / `salesforce-secret`
- `slack-workspace` / `slack-secret`
- `github-enterprise` / `github-secret`
- `azure-portal` / `azure-secret`

Each seeded client includes `http://localhost:3146/callback` as a local redirect URI.

## Main Pages

- `/oauth2/authorize` - sign in, sign up, and OAuth authorization entry
- `/oauth2/success` - direct sign-in success page
- `/profile` - current user profile and password management
- `/apps.html` - admin OAuth2 client management
- `/tokens.html` - admin access token audit and revocation
- `/api-docs.html` - endpoint reference

## OAuth2 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/openid-configuration` | OpenID Connect discovery |
| GET | `/.well-known/jwks.json` | HS256 note and empty public key set |
| GET/POST | `/oauth2/authorize` | Authorization Code flow and login |
| POST | `/oauth2/token` | Token exchange, refresh, and client credentials |
| GET | `/oauth2/userinfo` | UserInfo response for bearer tokens |
| POST | `/oauth2/introspect` | Access token introspection |
| POST | `/oauth2/revoke` | Access or refresh token revocation |

## Example Authorization Flow

Authorize:

```text
GET http://localhost:3146/oauth2/authorize?response_type=code&client_id=salesforce-prod&redirect_uri=http://localhost:3146/callback&scope=openid%20profile%20email&state=demo
```

Exchange the code:

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:3146/callback" \
  -d "client_id=salesforce-prod" \
  -d "client_secret=salesforce-secret"
```

Client authentication can also use HTTP Basic:

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials"
```

## Checks

```bash
npm run check
```

This runs `node --check` over the server, database initializer, seed script, and models.
