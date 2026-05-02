# Testing Guide - Pixora API

## Quick Start Testing

### 1. Local Development Testing

#### Option A: Direct Node.js
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your Azure credentials

# Start development server with auto-reload
npm run dev
```

Server will run at: `http://localhost:3000`

#### Option B: Docker Compose
```bash
# Start all services (API + Redis + Azurite)
docker-compose up -d

# View logs
docker-compose logs -f api

# Stop all services
docker-compose down
```

### 2. Health Checks

#### Basic Health Check
```bash
curl http://localhost:3000/health
```

Expected Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-04-30T12:00:00.000Z",
  "version": "1.0.0",
  "env": "development"
}
```

#### Deep Health Check (All Dependencies)
```bash
curl http://localhost:3000/health/deep
```

Expected Response:
```json
{
  "status": "healthy",
  "checks": {
    "api": "ok",
    "cosmos": "ok",
    "redis": "ok",
    "blob": "ok"
  }
}
```

## Testing Different Scenarios

### Scenario 1: Public Photo Listing (No Auth Required)

```bash
# List all photos
curl -X GET http://localhost:3000/v1/photos

# List with pagination
curl -X GET "http://localhost:3000/v1/photos?limit=10&offset=0"

# List with search/filter
curl -X GET "http://localhost:3000/v1/photos?search=sunset&status=published"
```

### Scenario 2: Upload Photo (Requires Creator Auth)

First, obtain a JWT token from Azure AD B2C:
```bash
# This would be obtained from Azure AD B2C login flow
export JWT_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6IkExMjM0IiwidHlwIjoiSldUIn0..."

# Upload a photo
curl -X POST http://localhost:3000/v1/photos \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@test.jpg" \
  -F "title=My Sunset Photo" \
  -F "description=Beautiful sunset at the beach" \
  -F "tags=sunset,beach"
```

Expected Response:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "creatorId": "user-123",
  "title": "My Sunset Photo",
  "description": "Beautiful sunset at the beach",
  "originalUrl": "https://storage.azure.com/photos/550e8400-e29b-41d4-a716-446655440000.jpg",
  "thumbnailUrl": "https://storage.azure.com/thumbnails/550e8400-e29b-41d4-a716-446655440000.jpg",
  "createdAt": "2024-04-30T12:00:00Z",
  "updatedAt": "2024-04-30T12:00:00Z",
  "status": "published",
  "viewCount": 0
}
```

### Scenario 3: Add Comment to Photo

```bash
export PHOTO_ID="550e8400-e29b-41d4-a716-446655440000"

curl -X POST "http://localhost:3000/v1/photos/$PHOTO_ID/comments" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Beautiful photo! Love the colors."
  }'
```

### Scenario 4: Rate Photo

```bash
curl -X POST "http://localhost:3000/v1/photos/$PHOTO_ID/ratings" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rating": 5,
    "comment": "Excellent work!"
  }'
```

### Scenario 5: Get User Profile

```bash
export USER_ID="user-123"

# Get user profile
curl "http://localhost:3000/v1/users/$USER_ID"

# Get user's photos
curl "http://localhost:3000/v1/users/$USER_ID/photos"

# Get user statistics
curl "http://localhost:3000/v1/users/$USER_ID/stats"
```

## Automated Testing

### Jest Unit Tests

```bash
cd backend

# Run all tests
npm test

# Run specific test file
npm test -- photos.test.js

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

### Integration Tests

```bash
# Run integration tests (requires Docker)
npm run test:integration

# Run with specific database
npm run test:integration -- --db cosmos
```

## Performance Testing

### Load Testing with Apache Bench

```bash
# Install Apache Bench (if not already installed)
# macOS: brew install httpd
# Ubuntu: sudo apt-get install apache2-utils

# Test 1000 requests with 10 concurrent connections
ab -n 1000 -c 10 http://localhost:3000/v1/photos

# Expected metrics:
# - Requests per second > 100
# - Time per request < 100ms
```

### Load Testing with Artillery

```bash
# Install Artillery
npm install -g artillery

# Create load.yml
cat > load.yml << 'EOF'
config:
  target: "http://localhost:3000"
  phases:
    - duration: 60
      arrivalRate: 10
scenarios:
  - name: "Browse Photos"
    flow:
      - get:
          url: "/v1/photos"
      - think: 5
      - get:
          url: "/v1/photos/{{ photoId }}"
EOF

# Run load test
artillery run load.yml
```

### Stress Testing with Artillery

```bash
cat > stress.yml << 'EOF'
config:
  target: "http://localhost:3000"
  phases:
    - duration: 30
      arrivalRate: 5
    - duration: 30
      arrivalRate: 10
    - duration: 30
      arrivalRate: 20
    - duration: 30
      arrivalRate: 50
scenarios:
  - name: "Upload Photos"
    flow:
      - post:
          url: "/v1/photos"
          headers:
            Authorization: "Bearer {{ token }}"
          formData:
            title: "Photo {{ $timestamp }}"
            file: "@test.jpg"
EOF

artillery run stress.yml
```

## Security Testing

### CORS Testing
```bash
# Should be rejected (origin not in ALLOWED_ORIGINS)
curl -H "Origin: http://malicious.com" \
     -H "Access-Control-Request-Method: POST" \
     http://localhost:3000/v1/photos

# Should succeed
curl -H "Origin: http://localhost:3001" \
     -H "Access-Control-Request-Method: POST" \
     http://localhost:3000/v1/photos
```

### Rate Limit Testing
```bash
# Should return 429 after exceeding rate limit
for i in {1..310}; do
  curl http://localhost:3000/v1/photos -s -o /dev/null -w "%{http_code}\n"
done
```

### JWT Validation Testing
```bash
# Invalid token (should return 401)
curl -H "Authorization: Bearer invalid.token.here" \
     http://localhost:3000/v1/auth/profile

# Expired token (should return 401)
curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2MzAwMDAwMDB9.signature" \
     http://localhost:3000/v1/auth/profile

# No token (public endpoint - should work)
curl http://localhost:3000/v1/photos
```

## Endpoint-by-Endpoint Test Scripts

### Test Script for Photos Endpoint
```bash
#!/bin/bash

BASE_URL="http://localhost:3000"
JWT_TOKEN="${JWT_TOKEN:-your-token-here}"

echo "=== Testing Photos Endpoints ==="

echo "1. GET /v1/photos (public)"
curl -s "$BASE_URL/v1/photos" | jq '.'

echo "2. POST /v1/photos (upload)"
curl -s -X POST "$BASE_URL/v1/photos" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@test.jpg" \
  -F "title=Test Photo" | jq '.'

echo "3. GET /v1/photos/{id} (public)"
PHOTO_ID="550e8400-e29b-41d4-a716-446655440000"
curl -s "$BASE_URL/v1/photos/$PHOTO_ID" | jq '.'

echo "4. PATCH /v1/photos/{id} (update)"
curl -s -X PATCH "$BASE_URL/v1/photos/$PHOTO_ID" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated Title"}' | jq '.'

echo "5. DELETE /v1/photos/{id} (delete)"
curl -s -X DELETE "$BASE_URL/v1/photos/$PHOTO_ID" \
  -H "Authorization: Bearer $JWT_TOKEN" | jq '.'
```

Save as `test-photos.sh` and run:
```bash
chmod +x test-photos.sh
./test-photos.sh
```

## Environment-Specific Testing

### Development Environment
```bash
NODE_ENV=development npm run dev
# Verbose logging, hot reload, mock data available
```

### Staging Environment
```bash
NODE_ENV=staging npm start
# Real Azure services, production-like configuration
```

### Production Environment
```bash
NODE_ENV=production npm start
# Full security, no debug logs, optimized performance
```

## Debugging

### Enable Debug Logging
```bash
DEBUG=* npm run dev
# or
DEBUG=pixora:* npm run dev
```

### Use Node Inspector
```bash
node --inspect=0.0.0.0:9229 server.js

# In Chrome: chrome://inspect
# or VS Code: F5 (with debugger configured)
```

### Database Query Testing
```bash
# Test Cosmos DB connection
node -e "
const cosmos = require('./services/cosmos');
(async () => {
  const { resources } = await cosmos.container('Photos').items.readAll().fetchAll();
  console.log('Found', resources.length, 'photos');
})();
"
```

### Redis Testing
```bash
# Connect to Redis container
docker exec -it pixora-redis redis-cli -a devpassword

# Inside Redis CLI:
> PING
> KEYS *
> GET user:123
> DEL user:123
```

## Troubleshooting Test Failures

| Error | Cause | Solution |
|-------|-------|----------|
| `ECONNREFUSED` | Service not running | Start service: `npm run dev` or `docker-compose up` |
| `401 Unauthorized` | Invalid/missing JWT | Obtain fresh token from Azure AD B2C |
| `413 Payload Too Large` | File exceeds limit | Check MAX_FILE_SIZE in .env (default 20MB) |
| `429 Too Many Requests` | Rate limit exceeded | Wait 15 minutes or adjust RATE_LIMIT_MAX |
| `ENOTFOUND` | Service endpoint not found | Verify Azure resources exist and endpoints are correct |
| `CORS error` | Origin not allowed | Add origin to ALLOWED_ORIGINS in .env |

## Continuous Integration (CI)

### GitHub Actions Example
```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
      - run: npm run test:integration
```

## Next Steps

1. ✅ Run health checks
2. ✅ Test public endpoints (no auth)
3. ✅ Obtain JWT token from Azure AD B2C
4. ✅ Test authenticated endpoints
5. ✅ Run full test suite
6. ✅ Run load tests
7. ✅ Test security scenarios
8. ✅ Verify rate limiting

---

**For more information, see: [README.md](../README.md)**
