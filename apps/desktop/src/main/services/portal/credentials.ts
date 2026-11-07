import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the app needs to talk to the portal: a stable installation identity plus
 * the credential pair issued for it.
 *
 * The identity outlives revocations on purpose — an administrator can revoke an
 * installation, and re-enrolling the same id is how it comes back without
 * turning into a second row.
 */
export interface PortalCredentials {
  installId: string;
  accessToken: string | null;
  accessExpiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
}

const EMPTY_TOKENS = {
  accessToken: null,
  accessExpiresAt: null,
  refreshToken: null,
  refreshExpiresAt: null
} as const;

/**
 * Tokens live in one JSON file under `userData` (mode 0600) rather than in the
 * database: they are bearer credentials, and the database is copied around by
 * backups. Cached in memory so a request path never touches the disk twice.
 */
export class PortalCredentialStore {
  private cached: PortalCredentials | null = null;

  constructor(private readonly file: string) {}

  async load(): Promise<PortalCredentials> {
    if (this.cached) {
      return this.cached;
    }

    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<PortalCredentials>;
      this.cached = {
        installId: typeof parsed.installId === "string" && parsed.installId.length >= 8
          ? parsed.installId
          : randomUUID(),
        accessToken: parsed.accessToken ?? null,
        accessExpiresAt: parsed.accessExpiresAt ?? null,
        refreshToken: parsed.refreshToken ?? null,
        refreshExpiresAt: parsed.refreshExpiresAt ?? null
      };
    } catch {
      this.cached = { installId: randomUUID(), ...EMPTY_TOKENS };
      // Persist at once: a second process run must see the same identity, or
      // every start would enroll as a brand-new installation.
      await this.persist(this.cached);
    }

    return this.cached;
  }

  /** The installation id, generated and persisted on first use. */
  async installId(): Promise<string> {
    return (await this.load()).installId;
  }

  async saveCredentials(input: {
    accessToken: string;
    accessExpiresAt: string;
    refreshToken: string;
    refreshExpiresAt: string;
  }): Promise<void> {
    const current = await this.load();
    await this.persist({ ...current, ...input });
  }

  async clearTokens(): Promise<void> {
    const current = await this.load();
    await this.persist({ ...current, ...EMPTY_TOKENS });
  }

  private async persist(next: PortalCredentials): Promise<void> {
    this.cached = next;
    await mkdir(dirname(this.file), { recursive: true });

    // Write-then-rename: a crash mid-write must not leave an unreadable file
    // that would look like "never enrolled" and silently issue a second token.
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
