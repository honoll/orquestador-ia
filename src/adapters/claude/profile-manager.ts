import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pino from "pino";

const log = pino({ name: "claude-profiles" });

export interface ClaudeProfile {
  id: string;
  label: string;
  apiKey?: string | null; // ANTHROPIC_API_KEY — null means use default CLI auth
}

export interface ProfileStatus {
  id: string;
  label: string;
  hasApiKey: boolean;
  rateLimitedUntil: string | null;
  available: boolean;
}

const CONFIG_PATH = path.join(os.homedir(), ".orquestador-ia", "claude-profiles.json");

class ClaudeProfileManager {
  private profiles: ClaudeProfile[] = [{ id: "default", label: "Cuenta 1", apiKey: null }];
  private rateLimits = new Map<string, Date>();

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.profiles = parsed;
        }
      } else {
        this.save();
      }
    } catch (err) {
      log.error({ err }, "Failed to load claude-profiles.json, using defaults");
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.profiles, null, 2));
    } catch (err) {
      log.error({ err }, "Failed to save claude-profiles.json");
    }
  }

  getProfiles(): ClaudeProfile[] {
    return [...this.profiles];
  }

  getProfilesStatus(): ProfileStatus[] {
    const now = new Date();
    return this.profiles.map((p) => {
      const rl = this.rateLimits.get(p.id);
      const limited = rl && rl > now ? rl.toISOString() : null;
      return {
        id: p.id,
        label: p.label,
        hasApiKey: !!p.apiKey,
        rateLimitedUntil: limited,
        available: !limited,
      };
    });
  }

  /** Returns the env override for a profile (ANTHROPIC_API_KEY if set) */
  getEnvForProfile(profileId: string): Record<string, string> {
    const p = this.profiles.find((p) => p.id === profileId);
    if (p?.apiKey) return { ANTHROPIC_API_KEY: p.apiKey };
    return {};
  }

  getBestProfile(): ClaudeProfile {
    const now = new Date();
    let fallback = this.profiles[0];
    let fallbackTime = this.rateLimits.get(fallback.id) ?? new Date(0);

    for (const p of this.profiles) {
      const rl = this.rateLimits.get(p.id);
      if (!rl || rl <= now) return p;
      if (rl < fallbackTime) { fallback = p; fallbackTime = rl; }
    }
    return fallback;
  }

  getNextProfile(currentId: string): ClaudeProfile | null {
    if (this.profiles.length <= 1) return null;
    const idx = this.profiles.findIndex((p) => p.id === currentId);
    if (idx === -1) return null;
    const now = new Date();
    for (let i = 1; i < this.profiles.length; i++) {
      const candidate = this.profiles[(idx + i) % this.profiles.length];
      const rl = this.rateLimits.get(candidate.id);
      if (!rl || rl <= now) return candidate;
    }
    return this.profiles[(idx + 1) % this.profiles.length];
  }

  markRateLimited(profileId: string, retryNotBefore: string | null) {
    const until = retryNotBefore
      ? new Date(retryNotBefore)
      : new Date(Date.now() + 60_000);
    this.rateLimits.set(profileId, until);
    log.warn({ profileId, until: until.toISOString() }, "Claude profile rate-limited");
  }

  clearRateLimit(profileId: string) {
    this.rateLimits.delete(profileId);
  }

  addProfile(profile: ClaudeProfile) {
    if (!this.profiles.find((p) => p.id === profile.id)) {
      this.profiles.push(profile);
      this.save();
    }
  }

  removeProfile(id: string) {
    if (this.profiles.length <= 1) return;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.rateLimits.delete(id);
    this.save();
  }

  updateProfile(id: string, updates: Partial<Pick<ClaudeProfile, "label" | "apiKey">>) {
    const p = this.profiles.find((p) => p.id === id);
    if (p) { Object.assign(p, updates); this.save(); }
  }
}

export const claudeProfileManager = new ClaudeProfileManager();
