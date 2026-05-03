/**
 * Azure Cosmos DB Service
 * Updated to match Azure container names: Users, Photos, Comments, Ratings
 */
const { CosmosClient } = require('@azure/cosmos');

const endpoint = process.env.COSMOS_ENDPOINT;
const key      = process.env.COSMOS_KEY;
const dbName   = process.env.COSMOS_DB_NAME || 'PixoGram';

let _client, _db, _containers;

function getClient() {
  if (!_client) {
    _client = new CosmosClient({
      endpoint,
      key,
      connectionPolicy: {
        requestTimeout: 10000,
        retryOptions: {
          maxRetryAttemptCount: 3,
          fixedRetryIntervalInMilliseconds: 500,
          maxWaitTimeInSeconds: 10,
        },
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
      Users:    db.container('Users'),
      Photos:   db.container('Photos'),
      Comments: db.container('Comments'),
      Ratings:  db.container('Ratings'),
    };
    console.log('[cosmos] Containers initialised:', Object.keys(_containers));
  }
  return _containers;
}

async function deleteByPhotoId(containerName, photoId) {
  const container = getContainers()[containerName];
  const { resources } = await container.items.query({
    query: 'SELECT c.id FROM c WHERE c.photoId = @photoId',
    parameters: [{ name: '@photoId', value: photoId }],
  }).fetchAll();

  for (let i = 0; i < resources.length; i += 10) {
    await Promise.allSettled(
      resources.slice(i, i + 10).map(doc => container.item(doc.id, photoId).delete())
    );
  }
}

async function initDatabase() {
  const client = getClient();
  const { database } = await client.databases.createIfNotExists({ id: dbName });

  const containerDefs = [
    { id: 'Users',    partitionKey: { paths: ['/id'] },      defaultTtl: -1 },
    { id: 'Photos',   partitionKey: { paths: ['/id'] },      defaultTtl: -1 },
    { id: 'Comments', partitionKey: { paths: ['/photoId'] }, defaultTtl: -1 },
    { id: 'Ratings',  partitionKey: { paths: ['/photoId'] }, defaultTtl: -1 },
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
  container: (name) => getContainers()[name],
  deleteByPhotoId,
  initDatabase,
};