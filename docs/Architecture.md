# Pixora — Cloud-Native Photo Sharing Platform
## Full Architecture & Design Document

---

## 1. Overview

**Pixora** is a scalable, cloud-native photo-sharing web application hosted entirely on **Microsoft Azure**. It supports two distinct user roles — **Creators** (upload/manage photos) and **Consumers** (browse/search/comment/rate photos) — and is architected to scale elastically, handle high read throughput via caching, and persist all data reliably through managed Azure services.

---

## 2. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AZURE CLOUD                                      │
│                                                                             │
│  ┌─────────────────────┐       ┌──────────────────────────────────────────┐│
│  │  Azure Front Door   │──────▶│  Azure CDN (Static + Media Caching)    ││
│  │  (Global DNS + WAF) │       └──────────────────────────────────────────┘│
│  └──────────┬──────────┘                          │                         │
│             │                                     ▼                         │
│             │                    ┌─────────────────────────────┐            │
│             │                    │  Azure Blob Storage          │            │
│             │                    │  (Photos + Thumbnails)       │            │
│             │                    └─────────────────────────────┘            │
│             ▼                                                                │
│  ┌──────────────────────┐                                                   │
│  │  Azure Static Web    │  ◀── HTML / CSS / JS (Creator & Consumer Views)  │
│  │  Apps (Frontend)     │                                                   │
│  └──────────┬───────────┘                                                   │
│             │  REST API calls (HTTPS)                                        │
│             ▼                                                                │
│  ┌──────────────────────┐    ┌────────────────────┐                         │
│  │  Azure API Management│───▶│  Azure App Service  │                        │
│  │  (Gateway + Rate     │    │  (Node.js REST API) │                        │
│  │   Limiting + Auth)   │    │  (Auto-scale)       │                        │
│  └──────────────────────┘    └────────┬────────────┘                        │
│                                       │                                      │
│              ┌────────────────────────┼──────────────────────┐              │
│              ▼                        ▼                       ▼              │
│  ┌─────────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐│
│  │  Azure Cosmos DB    │  │  Azure Cache for │  │  Azure Cognitive         ││
│  │  (NoSQL - Users,    │  │  Redis           │  │  Services (Vision API)   ││
│  │   Photos, Comments, │  │  (Session cache, │  │  (Auto-tagging,          ││
│  │   Ratings)          │  │   Feed cache)    │  │   Content moderation)    ││
│  └─────────────────────┘  └──────────────────┘  └─────────────────────────┘│
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Azure Active Directory B2C (Identity & Role-Based Access Control)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Azure Monitor + Application Insights (Logging, Metrics, Alerting)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Azure Services Used

| Service | Purpose | Tier Recommendation |
|---|---|---|
| **Azure Static Web Apps** | Host HTML/CSS/JS frontend | Free / Standard |
| **Azure App Service** | Host Node.js REST API (auto-scale) | B1 → P2v3 |
| **Azure API Management** | API gateway, rate limiting, auth enforcement | Developer / Consumption |
| **Azure Cosmos DB (NoSQL)** | Persist users, photos metadata, comments, ratings | Free tier (400 RU/s) |
| **Azure Blob Storage** | Store original photos + generated thumbnails | LRS / GRS |
| **Azure CDN** | Cache and distribute static assets + media | Standard Microsoft |
| **Azure Front Door** | Global load balancing, WAF, DNS routing | Standard |
| **Azure Cache for Redis** | Cache feed results, session tokens, rate data | C0 Basic → C1 |
| **Azure AD B2C** | User identity, JWT auth, role claims | Free (50K MAU free) |
| **Azure Cognitive Services – Vision** | Auto-tag images, content moderation | Free tier (5K calls/mo) |
| **Azure Monitor / App Insights** | Logs, metrics, performance tracing | Pay-as-you-go |
| **Azure Key Vault** | Store secrets, connection strings | Standard |

---

## 4. Data Model

### 4.1 Users (Cosmos DB — `users` container)
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "Jane Doe",
  "role": "creator | consumer",
  "avatarUrl": "https://cdn.../avatar.jpg",
  "createdAt": "ISO8601",
  "bio": "string"
}
```

### 4.2 Photos (Cosmos DB — `photos` container)
```json
{
  "id": "uuid",
  "creatorId": "userId",
  "title": "string",
  "caption": "string",
  "location": "string",
  "peoplePresent": ["string"],
  "tags": ["auto", "tagged"],
  "blobUrl": "https://storage.../photo.jpg",
  "thumbnailUrl": "https://cdn.../thumb.jpg",
  "contentModerationPassed": true,
  "averageRating": 4.2,
  "ratingCount": 150,
  "commentCount": 32,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

### 4.3 Comments (Cosmos DB — `comments` container)
```json
{
  "id": "uuid",
  "photoId": "photoId",
  "userId": "userId",
  "displayName": "string",
  "text": "string",
  "createdAt": "ISO8601"
}
```

### 4.4 Ratings (Cosmos DB — `ratings` container)
```json
{
  "id": "userId_photoId",
  "photoId": "photoId",
  "userId": "userId",
  "value": 1-5,
  "createdAt": "ISO8601"
}
```

---

## 5. REST API Specification

### Base URL: `https://api.pixora.io/v1`

All endpoints require `Authorization: Bearer <JWT>` except public browse/search endpoints.

#### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Exchange AAD B2C token for session |
| POST | `/auth/logout` | Invalidate session |

#### Photos
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/photos` | Public | List/search photos (query: `q`, `location`, `tags`, `page`, `limit`) |
| GET | `/photos/:id` | Public | Get single photo + metadata |
| POST | `/photos` | Creator | Upload new photo (multipart/form-data) |
| PATCH | `/photos/:id` | Creator (owner) | Update metadata |
| DELETE | `/photos/:id` | Creator (owner) | Delete photo |

#### Comments
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/photos/:id/comments` | Public | Get comments for photo |
| POST | `/photos/:id/comments` | Consumer/Creator | Add comment |
| DELETE | `/comments/:id` | Owner | Delete comment |

#### Ratings
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/photos/:id/ratings` | Consumer | Submit rating (1–5) |
| GET | `/photos/:id/ratings/me` | Consumer | Get own rating for photo |

#### Users
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/users/me` | Auth | Get own profile |
| PATCH | `/users/me` | Auth | Update profile |
| GET | `/users/:id/photos` | Public | Get photos by creator |

---

## 6. Authentication & Authorization (Azure AD B2C)

- **User Flows**: Sign-up/Sign-in user flow for Consumers. Creators are enrolled via admin-only invitation flow (no public registration).
- **Roles**: Custom `role` claim in JWT (`creator` or `consumer`).
- **Token Validation**: API Management policy validates JWT on every request, extracts `role` claim, and enforces route-level RBAC.
- **Frontend**: Uses MSAL.js (Microsoft Authentication Library) for silent token refresh and login redirect.

```
Consumer self-registers → AAD B2C assigns "consumer" role
Creator is invited by admin → AAD B2C assigns "creator" role
JWT contains: { sub, email, role, exp }
API Management validates JWT signature against B2C JWKS endpoint
App Service receives pre-validated request with X-User-Id and X-User-Role headers
```

---

## 7. Upload & Media Pipeline

```
Creator uploads image
        │
        ▼
App Service receives multipart upload
        │
        ├──▶ Validate file type (JPEG/PNG/WEBP only)
        ├──▶ Validate file size (max 20MB)
        │
        ▼
Azure Cognitive Services Vision API
        ├──▶ Content Moderation (adult/racy detection)
        ├──▶ Auto-tag generation (returned tags merged with user tags)
        │
        ▼
Azure Blob Storage
        ├──▶ Store original photo → /originals/{photoId}.jpg
        ├──▶ Generate thumbnail (Sharp.js) → /thumbnails/{photoId}.jpg
        │
        ▼
Cosmos DB
        └──▶ Write photo document with all metadata + blob URLs
```

---

## 8. Caching Strategy

| Layer | What's Cached | TTL | Technology |
|---|---|---|---|
| **CDN** | Thumbnails, original photos, static HTML/JS/CSS | 24h (media) / 1h (HTML) | Azure CDN |
| **Redis – Feed** | Homepage photo feed (top 50 recent) | 5 min | Azure Cache for Redis |
| **Redis – Search** | Search results by query hash | 2 min | Azure Cache for Redis |
| **Redis – Photo** | Individual photo detail pages | 10 min, invalidated on edit | Azure Cache for Redis |
| **Redis – Session** | Validated JWT claims | JWT expiry | Azure Cache for Redis |

---

## 9. Scalability & DNS Routing

- **Azure Front Door** provides global anycast DNS, routing requests to the nearest healthy App Service instance.
- **App Service Auto-scale** rules: scale out when CPU > 70% for 5 minutes; scale in when CPU < 30% for 15 minutes. Min: 1 instance, Max: 10 instances.
- **Cosmos DB** horizontally partitions `photos` by `creatorId` and `comments` by `photoId`.
- **Blob Storage** uses Zone-Redundant Storage (ZRS) for high availability.

---

## 10. Security

- All traffic via HTTPS (TLS 1.2+), enforced by Front Door and API Management.
- Azure API Management WAF rules block SQLi, XSS, and oversized payloads.
- Blob Storage containers are private; all media URLs are served through CDN with SAS tokens for private content or public CDN endpoints for approved content.
- Azure Key Vault stores all secrets (Cosmos DB connection strings, Redis passwords, Cognitive Services keys, B2C client secrets).
- App Service accesses Key Vault via Managed Identity (no credentials in code).
- Cosmos DB firewall restricts access to App Service outbound IPs only.

---

## 11. Deployment (IaC)

- **Bicep / ARM templates** define all Azure resources.
- **GitHub Actions** CI/CD pipeline:
  - On push to `main`: run tests → build → deploy frontend to Static Web Apps → deploy API to App Service.
  - Environment-specific configs via GitHub Secrets.

---

## 12. Cost Estimate (Monthly, Free/Dev Tier)

| Service | Est. Monthly Cost |
|---|---|
| Static Web Apps (Free) | £0 |
| App Service B1 | ~£12 |
| Cosmos DB (Free 400 RU/s) | £0 |
| Blob Storage (50GB LRS) | ~£1 |
| Azure CDN (100GB egress) | ~£7 |
| Azure AD B2C (≤50K MAU) | £0 |
| Redis Cache C0 | ~£13 |
| Cognitive Services (≤5K calls) | £0 |
| API Management Consumption | ~£0 (pay per call) |
| Front Door Standard | ~£22 |
| **Total** | **~£55/month** |

Production scale would increase primarily in App Service tier, Redis tier, and CDN egress costs.

---

## 13. File Structure

```
pixora/
├── frontend/
│   ├── index.html              # Landing / login page
│   ├── consumer.html           # Consumer browse/search view
│   ├── creator.html            # Creator dashboard / upload view
│   ├── photo.html              # Single photo detail view
│   └── assets/
│       ├── app.js              # Shared auth + API client (MSAL)
│       ├── consumer.js         # Consumer-specific logic
│       ├── creator.js          # Creator-specific logic
│       └── style.css           # Shared styles
├── backend/
│   ├── package.json
│   ├── server.js               # Express entry point
│   ├── routes/
│   │   ├── photos.js
│   │   ├── comments.js
│   │   ├── ratings.js
│   │   └── users.js
│   ├── middleware/
│   │   ├── auth.js             # JWT validation
│   │   └── rbac.js             # Role enforcement
│   ├── services/
│   │   ├── cosmos.js           # Cosmos DB client
│   │   ├── blob.js             # Azure Blob Storage client
│   │   ├── redis.js            # Redis cache client
│   │   └── vision.js           # Cognitive Services client
│   └── utils/
│       └── thumbnail.js        # Sharp.js thumbnail generation
├── infrastructure/
│   ├── main.bicep              # Root Bicep template
│   ├── cosmos.bicep
│   ├── storage.bicep
│   ├── appservice.bicep
│   └── frontdoor.bicep
└── docs/
    └── ARCHITECTURE.md
```