import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";

import config from "./config.json" assert { type: "json" };
import commands from "./commands/commands.js";
import registerCommands from "./commands/registerCommands.js";
import { listVoices, synthesize } from "./tts/tts.js";
import { ComponentType } from "discord.js";
import { scheduleJob } from "node-schedule";
import { readFile, writeFile } from "node:fs/promises";

const defaultVoice = "en-US-News-N";

let listening = false;
let channelName;
let subscription;
let queue = [];
let playing = false;
let voiceSelections = {};

(async () => {
  // register slash commands
  try {
    await registerCommands(commands);
  } catch (e) {
    console.error("Error registering commands: ", e);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  scheduleJob("0 10 * * *", async () => {
    const jsonString = await readFile("./birthdays.json", {
      encoding: "utf-8",
    });
    const birthdaysObject = JSON.parse(jsonString);
    const today = new Date();
    const day = today.getDate().toString();
    const month = (today.getMonth() + 1).toString();

    Object.entries(birthdaysObject).forEach(([userMentionString, birthday]) => {
      const [storedMonth, storedDay] = birthday.split("/");
      if (storedDay === day && storedMonth === month) {
        const channel = client.channels.cache.get("935746352502173777");
        channel.send(`Happy birthday ${userMentionString}! 🎂🎉`);
      }
    });
  });
  
  const voicesJson = await readFile("./voices.json", {
    encoding: "utf-8",
  });
  voiceSelections = JSON.parse(voicesJson);

  const player = createAudioPlayer();

  player.on(AudioPlayerStatus.Idle, () => {
    const resource = queue.shift();
    if (resource) {
      player.play(resource);
      return;
    }
    playing = false;
  });

  player.on(AudioPlayerStatus.Playing, () => {
    playing = true;
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "starttts") {
      await interaction.deferReply();
      if (!interaction.member.voice.channel) {
        await interaction.editReply("You must be in a voice channel");
        return;
      }

      let connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: interaction.member.voice.channel.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        subscription = connection.subscribe(player);
        listening = true;
        channelName = interaction.member.voice.channel.name;
      }
      interaction.editReply(
        "joined your channel and started listening to #no-mic",
      );
    }

    if (interaction.commandName === "stoptts") {
      if (!interaction.member.voice.channel) {
        await interaction.reply("You must be in a voice channel");
        return;
      }

      let connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        await interaction.reply("tts is not enabled");
        return;
      }

      player.stop();
      subscription.unsubscribe();
      connection.destroy();
      listening = false;
      playing = false;
      channelName = null;
      interaction.reply("left the channel and stopped listening to #no-mic");
    }

    if (interaction.commandName === "setvoice") {
      await interaction.deferReply();
      let voices = [];
      try {
        voices = await listVoices();
      } catch (e) {
        await interaction.editReply({
          content: "There was an error fetching voices: " + e,
        });
        return;
      }

      const rows = chunkArray(voices, 25).map((chunk, i) => {
        const options = chunk.map((voice) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${voice.name} - ${voice.ssmlGender}`)
            .setValue(voice.name),
        );
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("voice select" + i)
          .setPlaceholder("Select a voice...")
          .addOptions(options);
        return new ActionRowBuilder().addComponents(selectMenu);
      });

      const response = await interaction.editReply({
        content: "Choose a voice from one of the lists",
        components: [...rows],
      });

      const collectorFilter = (i) => i.user.id === interaction.user.id;

      try {
        const selection = await response.awaitMessageComponent({
          filter: collectorFilter,
          time: 60_000,
          componentType: ComponentType.StringSelect,
        });

        const selectedVoice = selection.values[0];
        const jsonString = await readFile("./voices.json", {
          encoding: "utf-8",
        });
        const voicesObject = JSON.parse(jsonString);
        voiceSelections = {
          ...voicesObject,
          [interaction.user.id]: selectedVoice
        };
        await writeFile("./voices.json", JSON.stringify(voiceSelections));
        
        await selection.update({
          content: `✅ Your voice was changed to ${selectedVoice}`,
          components: [],
        });
      } catch (e) {
        await interaction.editReply({
          content: "Selection was not made within 1 minute, aborting",
          components: [],
        });
      }
    }

    if (interaction.commandName === "setbirthday") {
      const user = interaction.options.getUser("user");
      const userMentionString = user.toString();

      const dateString = interaction.options.getString("date");
      const dateRegex = /^(1[0-2]|[1-9])\/(3[01]|[12][0-9]|[1-9])$/;
      if (!dateString.match(dateRegex)) {
        await interaction.reply(
          "That date is not in valid MM/DD format. Remember to not include leading zeros.",
        );
        return;
      }

      try {
        const jsonString = await readFile("./birthdays.json", {
          encoding: "utf-8",
        });
        const birthdaysObject = JSON.parse(jsonString);
        const newBirthdaysObject = {
          ...birthdaysObject,
          [userMentionString]: dateString,
        };
        await writeFile("./birthdays.json", JSON.stringify(newBirthdaysObject));
        await interaction.reply(`✅ added ${user}'s birthday`);
      } catch (e) {
        await interaction.reply("There was an error: " + e);
      }
    }

    if (interaction.commandName === "listbirthdays") {
      try {
        const jsonString = await readFile("./birthdays.json", {
          encoding: "utf-8",
        });
        const birthdaysObject = JSON.parse(jsonString);
        const birthdaysString = Object.entries(birthdaysObject)
          .sort((a, b) => {
            const [, firstDateString] = a;
            const [, secondDateString] = b;
            const firstDate = new Date(firstDateString + "/2023");
            const secondDate = new Date(secondDateString + "/2023");
            if (firstDate < secondDate) return -1;
            if (firstDate > secondDate) return 1;
            if (firstDate === secondDate) return 0;
          })
          .reduce((acc, cur) => {
            const [userMentionString, birthday] = cur;
            const line = `${userMentionString} - ${birthday}\n`;
            acc += line;
            return acc;
          }, "");
        await interaction.reply(birthdaysString);
      } catch (e) {
        await interaction.reply("There was an error: " + e);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guildId) return;
    if (!listening) return;
    if (message.channel.name !== "no-mic") return;
    if (!message.member.voice.channel) return;
    if (message.member.voice.channel.name !== channelName) return;
    if (message.member.id === config.clientId) return;
    if (message.content.length > 200 && message.member.id !== '179336900983652352') {
      await message.reply("that message is too long");
      return;
    }
    if (!message.member.voice.selfMute) return;

    const username = message.member.user.username.split("#")[0];
    const contentWithReadableEmojis = message.content.replace(
      /<:(.+?):\d+>/,
      "$1",
    );
    const contentWithNoUrls = contentWithReadableEmojis.replace(
      /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/,
      "",
    );

    if (!contentWithNoUrls) return;

    const selectedVoice = voiceSelections[message.member.id];
    const voice = selectedVoice ? selectedVoice : defaultVoice;
    try {
      const resource = await synthesize(contentWithNoUrls, voice);
      if (!playing) {
        player.play(resource);
      } else {
        queue.push(resource);
      }
    } catch (e) {
      console.error("There was an error: ", e);
    }
  });

  await client.login(config.token);
  console.log("ready");
})();

function chunkArray(arr, chunkSize) {
  const res = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    res.push(chunk);
  }
  return res;
}
