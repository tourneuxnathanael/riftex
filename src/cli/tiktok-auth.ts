/**
 * Flux OAuth TikTok en local :
 *   npm run tiktok:auth                 -> ouvre un serveur sur TIKTOK_REDIRECT_URI et affiche l'URL d'autorisation
 *   npm run tiktok:auth -- --code XXX   -> échange manuel d'un code (si la redirect URI pointe ailleurs, ex. un tunnel HTTPS)
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { buildAuthUrl, exchangeCode } from "../services/tiktok.js";

const { values } = parseArgs({ options: { code: { type: "string" } } });

if (!config.tiktok.clientKey || !config.tiktok.clientSecret) {
  console.error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET manquants dans .env");
  process.exit(1);
}

if (values.code) {
  const token = await exchangeCode(values.code);
  console.log(`✔ Token enregistré (${config.tiktok.tokenPath}), scopes : ${token.scope}`);
  process.exit(0);
}

const redirect = new URL(config.tiktok.redirectUri);
const { url, state } = buildAuthUrl();

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", redirect.origin);
  if (reqUrl.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = reqUrl.searchParams.get("code");
  if (reqUrl.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("State invalide ou code absent.");
    return;
  }
  try {
    const token = await exchangeCode(code);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Connexion TikTok réussie, vous pouvez fermer cet onglet.");
    console.log(`✔ Token enregistré (${config.tiktok.tokenPath}), scopes : ${token.scope}`);
  } catch (err) {
    res.writeHead(500).end((err as Error).message);
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), () => {
  console.log("Ouvrez cette URL pour autoriser l'application :\n");
  console.log(url);
  console.log(`\nEn attente du callback sur ${config.tiktok.redirectUri} ...`);
});
