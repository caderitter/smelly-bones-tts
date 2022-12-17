import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';

import config from './config.json' assert { type: 'json' };
import commands from './commands/commands.js';
import registerCommands from './commands/registerCommands.js';
import { synthesize } from './tts/tts.js';

let listening = false;
let channelName;
let subscription;
let queue = [];
let playing = false;

(async () => {
  // register slash commands
  try {
    await registerCommands(commands);
  } catch (e) {
    console.error('Error registering commands: ', e);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
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

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'starttts') {
      if (!interaction.member.voice.channel) {
        await interaction.reply('You must be in a voice channel');
        return;
      }

      let connection = getVoiceConnection();
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
      interaction.reply('joined your channel and started listening to #no-mic');
    }

    if (interaction.commandName === 'stoptts') {
      if (!interaction.member.voice.channel) {
        await interaction.reply('You must be in a voice channel');
        return;
      }

      let connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        await interaction.reply('tts is not enabled');
        return;
      }

      player.stop();
      subscription.unsubscribe();
      connection.destroy();
      listening = false;
      playing = false;
      channelName = null;

      interaction.reply('left the channel and stopped listening to #no-mic');
    }
  });

  client.on(Events.MessageCreate, async message => {
    if (!message.guildId) return;
    if (!listening) return;
    if (message.channel.name !== 'no-mic') return;
    if (!message.member.voice.channel) return;
    if (message.member.voice.channel.name !== channelName) return;
    if (message.member.id === config.clientId) return;
    if (message.content.length > 1000) {
      await message.reply('that message is too long');
      return;
    }
    if (!message.member.voice.selfMute) return;

    const username = message.member.user.username.split('#')[0];
    const contentWithReadableEmojis = message.content.replace(
      /<:(.+?):\d+>/,
      '$1'
    );
    const contentWithNoUrls = contentWithReadableEmojis.replace(
      /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/,
      ''
    );

    if (!contentWithNoUrls) return;

    const text = `${username} said ${contentWithNoUrls}`;
    try {
      const resource = await synthesize(text);
      if (!playing) {
        player.play(resource);
      } else {
        queue.push(resource);
      }
    } catch (e) {
      console.error('There was an error: ', e);
    }
  });

  await client.login(config.token);
  console.log('ready');
})();
