import { REST, Routes } from "discord.js";
import config from "../config.json" assert { type: "json" };

export default async (commands) => {
  const rest = new REST({ version: "10" }).setToken(config.token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      {
        body: commands,
      },
    );
  } catch (error) {
    console.error(error);
  }
};
