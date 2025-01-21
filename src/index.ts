import { DirectClient } from "@elizaos/client-direct";
import {
  AgentRuntime,
  elizaLogger,
  settings,
  stringToUuid,
  Plugin,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
  type Action, HandlerCallback, Content, generateText, ModelClass,
  type Character,
} from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { solanaPlugin } from "@elizaos/plugin-solana";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { initializeDbCache } from "./cache/index.ts";
import { character } from "./character.ts";
import { startChat } from "./chat/index.ts";
import { initializeClients } from "./clients/index.ts";
import {
  getTokenForProvider,
  loadCharacters,
  parseArguments,
} from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;

const currentNewsAction: Action = {
  name: "LATEST_NEWS",
  similes: ["NEWS", "GET_NEWS", "GET_CURRENT_NEWS"],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description: "Returns latest news from news api by search term by user",
  handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
      _options: { [key: string]: unknown },
      _callback: HandlerCallback
  ) => {
    async function getCurrentNews(searchTerm: string): Promise<void> {
      const news_api_key = process.env.NEWS_API_KEY
      console.log(news_api_key)
      const response = await fetch(
          'https://newsapi.org/v2/everything?' +
          'q=' + searchTerm + '&' +
          'sortBy=popularity&' +
          'apiKey=' + news_api_key
      )
      const data = await response.json();
      return data.articles
          .slice(0, 5)
          .map(
              (article) =>
                  `${article.title}\n${article.description}\n${article.url}\n${article.content.slice(0,1000)}`
          )
          .join('\n\n');

    }

    const context = `
        Extract the search term from user's message. The message is:
        ${_message.content.text}
        Only respond with the search term do not include any other text
        `;

    const searchTerm = await generateText({
      runtime: _runtime,
      context,
      modelClass: ModelClass.SMALL,
      stop: ["\n"]
    })

    const currentNews = await getCurrentNews(searchTerm)

    const responseText = `The current news for search term ${searchTerm} is ${currentNews}`

    const newMemory: Memory = {
      userId: _message.agentId,
      agentId: _message.agentId,
      roomId: _message.roomId,
      content: {
        text: responseText,
        action: "CURRENT_NEWS_RESPONSE",
        source: _message.content?.source
      } as Content
    }

    await _runtime.messageManager.createMemory(newMemory);

    await _callback(newMemory.content)

    return true
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "please send me latest news" },
      },
      {
        user: "{{user2}}",
        content: { text: "", action: "LATEST_NEWS" },
      }
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "what is in the news today?", action: "LATEST_NEWS" },
      }
    ],
  ] as ActionExample[][]
};

export const devSchoolPlugin: Plugin = {
  name: "devschool",
  description: "Devscool example",
  actions: [
    currentNewsAction
  ],
  evaluators: [],
  providers: [],
};

export function createAgent(
  character: Character,
  db: any,
  cache: any,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name,
  );

  nodePlugin ??= createNodePlugin();

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      devSchoolPlugin,
      nodePlugin,
      character.settings?.secrets?.WALLET_PUBLIC_KEY ? solanaPlugin : null,
    ].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

async function startAgent(character: Character, directClient: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir);

    await db.init();

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    runtime.clients = await initializeClients(character, runtime);

    directClient.registerAgent(runtime);

    // report to console
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error,
    );
    console.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
};

const startAgents = async () => {
  const directClient = new DirectClient();
  let serverPort = parseInt(settings.SERVER_PORT || "3000");
  const args = parseArguments();

  let charactersArg = args.characters || args.character;
  let characters = [character];

  console.log("charactersArg", charactersArg);
  if (charactersArg) {
    characters = await loadCharacters(charactersArg);
  }
  console.log("characters", characters);
  try {
    for (const character of characters) {
      await startAgent(character, directClient as DirectClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }

  while (!(await checkPortAvailable(serverPort))) {
    elizaLogger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }

  // upload some agent functionality into directClient
  directClient.startAgent = async (character: Character) => {
    // wrap it so we don't have to inject directClient later
    return startAgent(character, directClient);
  };

  directClient.start(serverPort);

  if (serverPort !== parseInt(settings.SERVER_PORT || "3000")) {
    elizaLogger.log(`Server started on alternate port ${serverPort}`);
  }

  const isDaemonProcess = process.env.DAEMON_PROCESS === "true";
  if(!isDaemonProcess) {
    elizaLogger.log("Chat started. Type 'exit' to quit.");
    const chat = startChat(characters);
    chat();
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents:", error);
  process.exit(1);
});
