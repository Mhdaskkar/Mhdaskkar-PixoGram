/**
 * Azure Cosmos DB Service
 * NoSQL — partitioned containers for photos, comments, ratings, users
 */
const { CosmosClient } = require('@azure/cosmos');

const endpoint = process.env.COSMOS_ENDPOINT || 'https://pixora.documents.azure.com:443/';
const key      = process.env.COSMOS_KEY;       // loaded from Key Vault in production
const dbName   = process.env.COSMOS_DB_NAME || 'pixoradb';

let _client, _db, _containers;

function getClient() {
  if (!_client) {
    _client = new CosmosClient({
      endpoint,
      key,
      connectionPolicy: {
        requestTimeout: 10000,
        retryOptions: { maxRetryAttemptCount: 3, fixedRetryIntervalInMilliseconds: 500, maxWaitTimeInSeconds: 10 },
      },
    });
  }
  return _client;
}

function getDb() {
  if (!_db) _db = getClient().database(dbName);
  return _db;
}

function getContainers() {
  if (!_containers) {
    const db = getDb();
    _containers = {
      Photos:   db.container('Photos'),    // partitionKey: /id
      Comments: db.container('Comments'),  // partitionKey: /photoId
      Ratings:  db.container('Ratings'),   // partitionKey: /photoId
      Users:    db.container('Users'),     // partitionKey: /id
    };
  }
  return _containers;
}

/**
 * Cascade delete all documents where c.photoId === photoId
 * Used when a photo is deleted to clean up comments & ratings
 */
async function deleteByPhotoId(containerName, photoId) {
  const container = getContainers()[containerName];
  const { resources } = await container.items.query({
    query: 'SELECT c.id FROM c WHERE c.photoId = @photoId',
    parameters: [{ name: '@photoId', value: photoId }],
  }).fetchAll();

  // Delete in batches of 10
  const batches = [];
  for (let i = 0; i < resources.length; i += 10) {
    batches.push(resources.slice(i, i + 10));
  }
  for (const batch of batches) {
    await Promise.allSettled(
      batch.map(doc => container.item(doc.id, photoId).delete())
    );
  }
}

/**
 * Initialize database and containers (run at startup or deployment)
 */
async function initDatabase() {
  const client = getClient();
  const { database } = await client.databases.createIfNotExists({ id: dbName });

  const containerDefs = [
    { id: 'photos',   partitionKey: { paths: ['/id'] },      defaultTtl: -1 },
    { id: 'comments', partitionKey: { paths: ['/photoId'] }, defaultTtl: -1 },
    { id: 'ratings',  partitionKey: { paths: ['/photoId'] }, defaultTtl: -1 },
    { id: 'users',    partitionKey: { paths: ['/id'] },      defaultTtl: -1 },
  ];

  for (const def of containerDefs) {
    await database.containers.createIfNotExists(def, { offerThroughput: 400 });
    console.log(`Container ready: ${def.id}`);
  }
  console.log('Cosmos DB initialised');
}

module.exports = {
  get cosmosClient() { return getClient(); },
  get containers()   { return getContainers(); },
  deleteByPhotoId,
  initDatabase,
};
