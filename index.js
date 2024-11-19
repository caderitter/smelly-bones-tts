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

const DEFAULT_VOICE = "en-US-News-N";
const GUILD_ID = config.guildId;
const NO_MIC_TEXT_CHANNEL_ID = config.noMicTextChannelId;
const BIRTHDAY_TEXT_CHANNEL_ID = config.birthdayTextChannelId;

let listening = false;
let channelId;
let subscription;
let queue = [];
let playing = false;
let voiceSelections = {};
let banners = {};
let currentBanner;
let timeout;

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
        const channel = client.channels.cache.get(BIRTHDAY_TEXT_CHANNEL_ID);
        channel.send(`Happy birthday ${userMentionString}! 🎂🎉`);
      }
    });

    const bannerNames = Object.keys(banners).filter(
      (name) => name !== currentBanner
    );
    currentBanner = bannerNames[Math.floor(Math.random() * bannerNames.length)];
    const guild = client.guilds.cache.get(GUILD_ID);
    await guild.setBanner(banners[currentBanner]);
  });

  const voicesJson = await readFile("./voices.json", {
    encoding: "utf-8",
  });
  voiceSelections = JSON.parse(voicesJson);

  const bannersJson = await readFile("./banners.json", {
    encoding: "utf-8",
  });
  banners = JSON.parse(bannersJson);

  const player = createAudioPlayer();

  const disconnectTts = (connection) => {
    player?.stop();
    subscription?.unsubscribe();
    connection?.destroy();
    listening = false;
    playing = false;
    channelId = null;
    timeout = null;
  };

  player.on(AudioPlayerStatus.Idle, () => {
    const resource = queue.shift();
    if (resource) {
      player.play(resource);
      return;
    }
    playing = false;
    timeout = setTimeout(() => {
      let connection = getVoiceConnection(GUILD_ID);
      if (connection) {
        const noMicChannel = client.channels.cache.get(NO_MIC_TEXT_CHANNEL_ID);
        noMicChannel.send(
          "I didn't get any tts messages for 30 minutes, so I left."
        );
      }
      disconnectTts(connection);
    }, 1000 * 60 * 30);
  });

  player.on(AudioPlayerStatus.Playing, () => {
    playing = true;
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "starttts") {
      await interaction.deferReply();
      if (!interaction.member.voice.channel) {
        await interaction.editReply("❌ You must be in a voice channel");
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
        channelId = interaction.member.voice.channel.id;
      }
      await interaction.editReply(
        "joined your channel and started listening to #no-mic"
      );
    }

    if (interaction.commandName === "stoptts") {
      if (!interaction.member.voice.channel) {
        await interaction.reply("❌ You must be in a voice channel");
        return;
      }

      let connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        await interaction.reply("❌ tts is not enabled");
        return;
      }

      disconnectTts(connection);
      await interaction.reply(
        "left the channel and stopped listening to #no-mic"
      );
    }

    if (interaction.commandName === "setvoice") {
      await interaction.deferReply();
      let voices = [];
      try {
        voices = await listVoices();
      } catch (e) {
        await interaction.editReply({
          content: "❌ There was an error fetching voices: " + e,
        });
        return;
      }

      const rows = chunkArray(voices, 25).map((chunk, i) => {
        const options = chunk.map((voice) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${voice.name} - ${voice.ssmlGender}`)
            .setValue(voice.name)
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
          [interaction.user.id]: selectedVoice,
        };
        await writeFile("./voices.json", JSON.stringify(voiceSelections));

        await selection.update({
          content: `✅ Your voice was changed to ${selectedVoice}`,
          components: [],
        });
      } catch (e) {
        await interaction.editReply({
          content: "❌ Selection was not made within 1 minute, aborting",
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
          "❌ That date is not in valid MM/DD format. Remember to not include leading zeros."
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
        await interaction.reply(`✅ Added ${user}'s birthday`);
      } catch (e) {
        await interaction.reply("❌ There was an error: " + e);
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
            const firstDate = new Date(firstDateString + "/2024");
            const secondDate = new Date(secondDateString + "/2024");
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
        await interaction.reply("❌ There was an error: " + e);
      }
    }

    if (interaction.commandName === "addbanner") {
      const name = interaction.options.getString("name");
      const banner = interaction.options.getAttachment("banner");

      if (!banner.contentType.startsWith("image")) {
        await interaction.reply("❌ Must be an image");
        return;
      }

      try {
        const jsonString = await readFile("./banners.json", {
          encoding: "utf-8",
        });
        const oldBanners = JSON.parse(jsonString);
        // sadly, since discord makes attachment URLS temporary, we have to set the banner
        // immediately and then store that URL, which is permanent.
        await client.guilds.cache.get(GUILD_ID).setBanner(banner.url);
        const permanentUrl = client.guilds.cache.get(GUILD_ID).bannerURL();
        const newBanners = {
          ...oldBanners,
          [name]: `${permanentUrl}?size=480`,
        };
        banners = newBanners;
        await writeFile("./banners.json", JSON.stringify(banners));
        await interaction.reply(`✅ Added and set new banner ${name}`);
      } catch (e) {
        await interaction.reply("❌ There was an error: " + e);
      }
    }

    if (interaction.commandName === "listbanners") {
      try {
        const bannerNames = Object.entries(banners);
        const bannerString = bannerNames.reduce((acc, [name, url]) => {
          acc += `${name} - ${url}\n`;
          return acc;
        }, "");
        await interaction.reply(bannerString);
      } catch (e) {
        await interaction.reply("❌ There was an error: " + e);
      }
    }

    if (interaction.commandName === "setbanner") {
      await interaction.deferReply();
      const options = Object.keys(banners).map((banner) =>
        new StringSelectMenuOptionBuilder().setLabel(banner).setValue(banner)
      );
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("banner select")
        .setPlaceholder("Select a banner...")
        .addOptions(options);
      const row = new ActionRowBuilder().addComponents(selectMenu);
      const response = await interaction.editReply({
        content: "Choose a banner",
        components: [row],
      });

      try {
        const selection = await response.awaitMessageComponent({
          filter: (i) => i.user.id === interaction.user.id,
          time: 60_000,
          componentType: ComponentType.StringSelect,
        });

        const selectedBanner = selection.values[0];

        const guild = client.guilds.cache.get(GUILD_ID);
        await guild.setBanner(banners[selectedBanner]);

        await selection.update({
          content: `✅ Banner changed to ${selectedBanner}`,
          components: [],
        });
      } catch (e) {
        console.error(e);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guildId) return;
    if (!listening) return;
    if (message.channel.id !== NO_MIC_TEXT_CHANNEL_ID) return;
    if (!message.member.voice.channel) return;
    if (message.member.voice.channel.id !== channelId) return;
    if (message.member.id === config.clientId) return;
    if (message.content.length > 200) {
      await message.reply("❌ that message is too long");
      return;
    }
    if (!message.member.voice.selfMute) return;

    const contentWithReadableEmojis = message.content.replace(
      /<:(.+?):\d+>/,
      "$1"
    );
    const contentWithNoUrls = contentWithReadableEmojis.replace(
      /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/,
      ""
    );

    if (!contentWithNoUrls) return;

    const selectedVoice = voiceSelections[message.member.id];
    const voice = selectedVoice ? selectedVoice : DEFAULT_VOICE;
    try {
      const resource = await synthesize(contentWithNoUrls, voice);
      if (!playing) {
        player.play(resource);
      } else {
        queue.push(resource);
      }
    } catch (e) {
      "There was an error: ", e;
    }
  });

  client.on("voiceStateUpdate", (oldState, newState) => {
    if (!listening) return;
    const channel = oldState.channel || newState.channel;
    if (oldState.id === client.user.id) {
      if (oldState.channelId && !newState.channelId) {
        disconnectTts();
        return;
      }
    }

    if (channel && channel.id === channelId && channel.members.size === 1) {
      let connection = getVoiceConnection(GUILD_ID);
      if (!connection) {
        return;
      }

      disconnectTts(connection);
      const noMicChannel = client.channels.cache.get(NO_MIC_TEXT_CHANNEL_ID);

      noMicChannel.send("Everyone left the voice channel, so I left too.");
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
