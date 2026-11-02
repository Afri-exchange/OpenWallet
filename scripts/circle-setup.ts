// One-off Circle sandbox setup. Usage (secrets come from the environment, never the command line):
//   tsx scripts/circle-setup.ts wallet-set                      -> creates a wallet set, prints its id (CIRCLE_WALLET_SET_ID)
//   tsx scripts/circle-setup.ts subscribe https://<public>/webhooks/circle
import { CircleClient } from "../src/chain/circle.js";

const [cmd, arg] = process.argv.slice(2);
const key = process.env.CIRCLE_API_KEY;
const secret = process.env.CIRCLE_ENTITY_SECRET;
if (!key || !secret) throw new Error("set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in the environment");
if (!key.startsWith("TEST_API_KEY:")) throw new Error("sandbox only: use a Circle TEST_API_KEY");
const circle = new CircleClient({ apiKey: key, entitySecretHex: secret, walletSetId: process.env.CIRCLE_WALLET_SET_ID ?? "-" });
if (cmd === "wallet-set") console.log("CIRCLE_WALLET_SET_ID =", await circle.createWalletSet("agent-cards sandbox deposits"));
else if (cmd === "subscribe" && arg?.startsWith("https://")) console.log("subscription", (await circle.subscribe(arg)).id);
else throw new Error("usage: wallet-set | subscribe https://<public host>/webhooks/circle");
