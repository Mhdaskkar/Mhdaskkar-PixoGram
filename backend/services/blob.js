/**
 * Azure Blob Storage Service
 */
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const ACCOUNT_NAME   = process.env.AZURE_STORAGE_ACCOUNT || 'PixoGramstorage';
const ACCOUNT_KEY    = process.env.AZURE_STORAGE_KEY;
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'media';
const CDN_ENDPOINT   = process.env.AZURE_CDN_ENDPOINT || `https://PixoGram-cdn.azureedge.net/${CONTAINER_NAME}`;

let _blobServiceClient;

function getBlobServiceClient() {
  if (!_blobServiceClient) {
    const sharedKey = new StorageSharedKeyCredential(ACCOUNT_NAME, ACCOUNT_KEY);
    _blobServiceClient = new BlobServiceClient(
      `https://${ACCOUNT_NAME}.blob.core.windows.net`,
      sharedKey
    );
  }
  return _blobServiceClient;
}

/**
 * Upload a Buffer to Azure Blob Storage and return the CDN URL
 */
async function uploadBuffer(blobName, buffer, contentType) {
  const client        = getBlobServiceClient();
  const container     = client.getContainerClient(CONTAINER_NAME);
  const blockBlobClient = container.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: { uploadedAt: new Date().toISOString() },
  });

  // Return CDN URL (not direct blob URL) for cache + performance
  return `${CDN_ENDPOINT}/${blobName}`;
}

/**
 * Delete a blob by name
 */
async function deleteBlob(blobName) {
  const client    = getBlobServiceClient();
  const container = client.getContainerClient(CONTAINER_NAME);
  await container.deleteBlob(blobName, { deleteSnapshots: 'include' });
}

/**
 * Generate a time-limited SAS URL for a blob (for secure access to private content)
 */
async function generateSasUrl(blobName, expiryMinutes = 60) {
  const sharedKey   = new StorageSharedKeyCredential(ACCOUNT_NAME, ACCOUNT_KEY);
  const container   = getBlobServiceClient().getContainerClient(CONTAINER_NAME);
  const blobClient  = container.getBlobClient(blobName);

  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + expiryMinutes);

  const sasToken = generateBlobSASQueryParameters({
    containerName: CONTAINER_NAME,
    blobName,
    permissions: BlobSASPermissions.parse('r'),
    expiresOn,
  }, sharedKey).toString();

  return `${blobClient.url}?${sasToken}`;
}

module.exports = { uploadBuffer, deleteBlob, generateSasUrl };