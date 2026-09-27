import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class PhotoStorage {
  readonly bucket: string;
  private client: S3Client;
  constructor() {
    const { R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } =
      process.env;
    if (
      !R2_BUCKET ||
      !R2_ENDPOINT ||
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY
    )
      throw new Error("Photo storage is not configured");
    this.bucket = R2_BUCKET;
    this.client = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        CacheControl: "private, no-store",
      }),
    );
  }
  async read(key: string, maxBytes = 12 * 1024 * 1024) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body || (result.ContentLength || 0) > maxBytes)
      throw new Error("Invalid photo size");
    const bytes = await result.Body.transformToByteArray();
    if (bytes.length > maxBytes) throw new Error("Invalid photo size");
    return bytes;
  }
  async uploadUrl(key: string, mime: string, sha256: string) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mime,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      }),
      {
        expiresIn: 600,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );
  }
  async downloadUrl(key: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseCacheControl: "private, no-store",
      }),
      { expiresIn: 60 },
    );
  }
  async head(key: string) {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return { size: result.ContentLength, mime: result.ContentType };
  }
  async delete(keys: string[]) {
    if (!keys.length) return;
    const result = await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: {
          Objects: [...new Set(keys)].map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    if (result.Errors?.length) throw new Error("Photo cleanup will be retried");
  }
}
