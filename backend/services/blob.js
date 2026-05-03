const { BlobServiceClient } = require('@azure/storage-blob');

const CONNECTION_STRING = process.env.STORAGE_CONNECTION_STRING;
const CONTAINER_NAME    = process.env.STORAGE_CONTAINER_NAME || 'photos';
const THUMB_CONTAINER   = process.env.STORAGE_THUMBNAIL_CONTAINER || 'thumbnails';

let _client;

function getClient() {
  if (!_client) _client = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  return _client;
}

async function uploadBuffer(blobName, buffer, contentType) {
  const isThumb = blobName.startsWith('thumbnails/');
  const containerName = isThumb ? THUMB_CONTAINER : CONTAINER_NAME;
  const container = getClient().getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobName.replace('thumbnails/', ''));
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blockBlob.url;
}

async function deleteBlob(blobName) {
  const isThumb = blobName.startsWith('thumbnails/');
  const containerName = isThumb ? THUMB_CONTAINER : CONTAINER_NAME;
  const container = getClient().getContainerClient(containerName);
  const name = blobName.replace('thumbnails/', '').replace('originals/', '');
  await container.deleteBlob(name, { deleteSnapshots: 'include' });
}

module.exports = { uploadBuffer, deleteBlob };
