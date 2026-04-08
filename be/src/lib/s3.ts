import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.AWS_REGION || "us-east-1";
export const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export const BUCKET_NAME = process.env.S3_BUCKET_NAME || "gridnode-artifacts";

export async function generatePutUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: contentType });
  return getSignedUrl(s3Client, command, { expiresIn: 900 }); // Valid for 15 mins
}

export async function generateGetUrl(key: string) {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 }); // Valid for 1 hour
}
