import Anthropic from "@anthropic-ai/sdk";
import { createApp, MODEL } from "./app";

const PORT = Number(process.env.PORT ?? 8787);

createApp(new Anthropic()).listen(PORT, () => {
  console.log(`AI Reader server: http://localhost:${PORT}  (model: ${MODEL})`);
});
