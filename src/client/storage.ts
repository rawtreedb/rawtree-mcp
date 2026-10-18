export interface S3DestinationInput {
  bucket: string;
  path?: string;
}

export interface S3StorageInput {
  data: S3DestinationInput;
  backups: S3DestinationInput;
  roleArn: string;
  externalId: string;
}

export interface DatabaseS3AccessInput {
  externalId: string;
  databaseBucketTag: string;
}

export function s3StorageRequestBody(s3Storage: S3StorageInput) {
  return {
    data: {
      bucket: s3Storage.data.bucket,
      ...(s3Storage.data.path === undefined
        ? {}
        : { path: s3Storage.data.path }),
    },
    backups: {
      bucket: s3Storage.backups.bucket,
      ...(s3Storage.backups.path === undefined
        ? {}
        : { path: s3Storage.backups.path }),
    },
    role_arn: s3Storage.roleArn,
    external_id: s3Storage.externalId,
  };
}

export function databaseS3AccessRequestBody(
  databaseS3Access: DatabaseS3AccessInput,
) {
  return {
    external_id: databaseS3Access.externalId,
    database_bucket_tag: databaseS3Access.databaseBucketTag,
  };
}
