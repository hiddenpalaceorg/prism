// prism Discord bot. "!prism <query>" searches public builds by hash
// (sha256/md5/sha1, build- or file-level), build name, and filename, and
// replies with links to the build pages. Read-only; private builds are
// excluded by search()/searchFiles() themselves (visibleSql).
//
// Usage: npm run bot   (env DISCORD_TOKEN, DATABASE_URL, optional SITE_URL)
// The Discord application needs the Message Content intent enabled.

import { Client, EmbedBuilder, Events, GatewayIntentBits, Partials } from "discord.js";
import pg from "pg";
import { search, searchFiles } from "../src/lib/queries";
import { buildHref } from "../src/lib/slug";
import { loadDotEnv } from "./dotenv";

loadDotEnv();

const PREFIX = "!prism";
const MAX_RESULTS = 8;
const SITE = (process.env.SITE_URL ?? "https://hiddenpalace.org").replace(/\/+$/, "");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN must be set (web/.env.local)");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres:///prism_test",
  statement_timeout: 15_000,
});

interface Hit {
  sha256: string;
  name: string;
  system: string;
  file?: string;
}

/** Hash lookup when the term looks like one; otherwise name/FTS matches
 *  first, then builds matched only through a filename. */
async function findBuilds(term: string): Promise<Hit[]> {
  const r = await search(pool, term, MAX_RESULTS + 1);
  if (r.mode === "hash") return r.results;
  const byFile = await searchFiles(pool, term, MAX_RESULTS + 1);
  const seen = new Set(r.results.map((x) => x.sha256));
  const hits: Hit[] = [...r.results];
  for (const f of byFile) if (!seen.has(f.sha256)) hits.push(f);
  return hits;
}

/** Neutralize markdown in build names used as link text. Only characters
 *  Discord treats as markup — it renders a backslash before anything else
 *  (e.g. "\(") literally instead of unescaping it. */
const mdEscape = (s: string) => s.replace(/([\\`*_~|[\]])/g, "\\$1");

function formatReply(term: string, hits: Hit[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x8b5cf6);
  if (!hits.length) {
    return embed.setDescription(`No builds found for \`${term.replace(/`/g, "")}\`.`);
  }
  const lines = hits.slice(0, MAX_RESULTS).map((h) => {
    const link = `[${mdEscape(h.name)}](${SITE}${buildHref(h.sha256, h.name)})`;
    const file = h.file ? ` · file: \`${h.file.replace(/`/g, "")}\`` : "";
    return `${link} · ${h.system}${file}`;
  });
  if (hits.length > MAX_RESULTS) {
    lines.push(`[all results](${SITE}/builds?q=${encodeURIComponent(term)})`);
  }
  return embed.setDescription(lines.join("\n"));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // DM channels arrive uncached
});

client.once(Events.ClientReady, (c) => {
  console.log(`logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();
  if (!new RegExp(`^${PREFIX}(\\s|$)`, "i").test(content)) return;
  const term = content.slice(PREFIX.length).trim().slice(0, 256);
  try {
    if (!term) {
      await msg.reply({
        content: `usage: \`${PREFIX} <name, filename, or hash>\``,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }
    const hits = await findBuilds(term);
    await msg.reply({
      embeds: [formatReply(term, hits)],
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (e) {
    console.error(`search "${term}" failed:`, e);
    await msg
      .reply({ content: "Search failed, try again later.", allowedMentions: { parse: [], repliedUser: false } })
      .catch(() => {});
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    client.destroy();
    void pool.end().then(() => process.exit(0));
  });
}

client.login(token);
