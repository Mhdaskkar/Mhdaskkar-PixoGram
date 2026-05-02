# PixoGram — Azure Deployment & CI/CD Guide

This guide covers **every step** from zero to a live deployment on Azure,
using **local JWT auth** (no Azure AD B2C needed).

---

## Part 1 — Change B2C to JWT (already done in this repo)

| File | What changed |
|---|---|
| `middleware/auth.js` | Replaced `jwks-rsa` + `express-jwt` with plain `jsonwebtoken` |
| `routes/auth.js` | Added real `/register`, `/login`, `/refresh` endpoints with bcrypt |
| `package.json` | Removed `jwks-rsa`, `express-jwt` → added `bcryptjs` |
| `.env.example` | Replaced all `AZURE_B2C_*` vars with `JWT_SECRET`, `JWT_EXPIRY` |
| `docker-compose.yml` | Removed B2C environment vars |

---

## Part 2 — Azure Resources Setup (one-time)

### Step 1 — Install Azure CLI
```bash
# macOS
brew install azure-cli

# Ubuntu/Debian
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Windows — download from https://aka.ms/installazurecliwindows
az login
```

### Step 2 — Create a Resource Group
```bash
az group create \
  --name pixogram-rg \
  --location uksouth
```

### Step 3 — Create Azure Container Registry (ACR)
```bash
az acr create \
  --resource-group pixogram-rg \
  --name pixogramacr \
  --sku Basic \
  --admin-enabled true

# Get the credentials (save these — you need them for GitHub secrets)
az acr credential show --name pixogramacr
# Note: username and password fields
```

### Step 4 — Create Azure Cosmos DB
```bash
az cosmosdb create \
  --name pixogram-cosmos \
  --resource-group pixogram-rg \
  --kind GlobalDocumentDB \
  --locations regionName=uksouth failoverPriority=0

# Create the database
az cosmosdb sql database create \
  --account-name pixogram-cosmos \
  --resource-group pixogram-rg \
  --name PixoGram

# Create containers
az cosmosdb sql container create \
  --account-name pixogram-cosmos \
  --resource-group pixogram-rg \
  --database-name PixoGram \
  --name Users \
  --partition-key-path /id

az cosmosdb sql container create \
  --account-name pixogram-cosmos \
  --resource-group pixogram-rg \
  --database-name PixoGram \
  --name Photos \
  --partition-key-path /creatorId

az cosmosdb sql container create \
  --account-name pixogram-cosmos \
  --resource-group pixogram-rg \
  --database-name PixoGram \
  --name Comments \
  --partition-key-path /photoId

az cosmosdb sql container create \
  --account-name pixogram-cosmos \
  --resource-group pixogram-rg \
  --database-name PixoGram \
  --name Ratings \
  --partition-key-path /photoId

# Get the connection string
az cosmosdb keys list \
  --name pixogram-cosmos \
  --resource-group pixogram-rg \
  --type keys
# Save: primaryMasterKey
```

### Step 5 — Create Azure Blob Storage
```bash
az storage account create \
  --name pixogramstorage \
  --resource-group pixogram-rg \
  --location uksouth \
  --sku Standard_LRS

# Get connection string
az storage account show-connection-string \
  --name pixogramstorage \
  --resource-group pixogram-rg
# Save the entire connectionString value

# Create containers
az storage container create --name photos      --account-name pixogramstorage
az storage container create --name thumbnails  --account-name pixogramstorage
```

### Step 6 — Create Azure Cache for Redis
```bash
az redis create \
  --name pixogram-redis \
  --resource-group pixogram-rg \
  --location uksouth \
  --sku Basic \
  --vm-size c0

# Get host and password (takes ~15 min to provision)
az redis show \
  --name pixogram-redis \
  --resource-group pixogram-rg \
  --query hostName

az redis list-keys \
  --name pixogram-redis \
  --resource-group pixogram-rg
# Save: primaryKey and hostName
```

### Step 7 — Create Azure Computer Vision
```bash
az cognitiveservices account create \
  --name pixogram-vision \
  --resource-group pixogram-rg \
  --kind ComputerVision \
  --sku F0 \
  --location uksouth \
  --yes

az cognitiveservices account keys list \
  --name pixogram-vision \
  --resource-group pixogram-rg
# Save: key1

az cognitiveservices account show \
  --name pixogram-vision \
  --resource-group pixogram-rg \
  --query properties.endpoint
# Save: endpoint URL
```

### Step 8 — Create App Service Plan and Web App
```bash
az appservice plan create \
  --name pixogram-plan \
  --resource-group pixogram-rg \
  --is-linux \
  --sku B1

az webapp create \
  --resource-group pixogram-rg \
  --plan pixogram-plan \
  --name pixogram-api \
  --deployment-container-image-name pixogramacr.azurecr.io/pixogram-api:latest

# Allow App Service to pull from ACR
az webapp config container set \
  --name pixogram-api \
  --resource-group pixogram-rg \
  --docker-registry-server-url https://pixogramacr.azurecr.io \
  --docker-registry-server-user $(az acr credential show --name pixogramacr --query username -o tsv) \
  --docker-registry-server-password $(az acr credential show --name pixogramacr --query passwords[0].value -o tsv)
```

---

## Part 3 — Set Up GitHub Actions CI/CD

### Step 9 — Create Azure Service Principal for GitHub Actions
```bash
az ad sp create-for-rbac \
  --name "pixogram-github-actions" \
  --role contributor \
  --scopes /subscriptions/<YOUR_SUBSCRIPTION_ID>/resourceGroups/pixogram-rg \
  --sdk-auth
```
Copy the entire JSON output — you need it for the next step.

### Step 10 — Add GitHub Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

Add ALL of these secrets:

| Secret Name | Value |
|---|---|
| `AZURE_CREDENTIALS` | The full JSON from Step 9 |
| `ACR_USERNAME` | ACR username from Step 3 |
| `ACR_PASSWORD` | ACR password from Step 3 |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `COSMOS_ENDPOINT` | `https://pixogram-cosmos.documents.azure.com:443/` |
| `COSMOS_KEY` | primaryMasterKey from Step 4 |
| `REDIS_HOST` | Redis hostname from Step 6 (e.g. `pixogram-redis.redis.cache.windows.net`) |
| `REDIS_PASSWORD` | primaryKey from Step 6 |
| `STORAGE_CONNECTION_STRING` | Full connection string from Step 5 |
| `VISION_ENDPOINT` | Endpoint URL from Step 7 |
| `VISION_KEY` | key1 from Step 7 |
| `ALLOWED_ORIGINS` | `https://pixogram-api.azurewebsites.net` |

### Step 11 — Push to GitHub to trigger the pipeline
```bash
git add .
git commit -m "feat: replace B2C with JWT auth"
git push origin main
```

Watch the pipeline under **Actions** tab in GitHub.
Pipeline runs: **Test → Build Docker Image → Push to ACR → Deploy to App Service → Health Check**

---

## Part 4 — Verify Deployment

### Step 12 — Test the live API
```bash
BASE=https://pixogram-api.azurewebsites.net

# Health check
curl $BASE/health

# Register a new user
curl -X POST $BASE/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Password123!","role":"creator"}'

# Login
curl -X POST $BASE/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Password123!"}'
# Copy the "token" value from the response

# Access protected route
curl $BASE/v1/auth/profile \
  -H "Authorization: Bearer <token-from-above>"
```

---

## Part 5 — Local Development (no Azure needed)

```bash
# 1. Copy env file
cp .env.example .env
# Edit .env — only JWT_SECRET is required for auth to work locally

# 2. Start with Docker Compose
docker-compose up -d

# 3. Test locally
curl http://localhost:3000/health
curl -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@test.com","password":"password123","role":"consumer"}'
```

---

## JWT Auth Quick Reference

```
POST /v1/auth/register   { email, password, displayName?, role? }  → { token, user }
POST /v1/auth/login      { email, password }                        → { token, user }
POST /v1/auth/refresh    Authorization: Bearer <token>              → { token }
POST /v1/auth/logout     (stateless — discard token client-side)
GET  /v1/auth/profile    Authorization: Bearer <token>              → { user }

All protected routes: Authorization: Bearer <your-jwt-token>
```
