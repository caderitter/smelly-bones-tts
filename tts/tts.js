import { createAudioResource } from '@discordjs/voice';
import textToSpeech from '@google-cloud/text-to-speech';
import { Readable } from 'stream';

const client = new textToSpeech.TextToSpeechClient();

export const synthesize = async text => {
  const request = {
    input: { text },
    voice: { languageCode: 'en-UK', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  };

  const [{ audioContent }] = await client.synthesizeSpeech(request);
  const stream = Readable.from(audioContent);
  const resource = createAudioResource(stream);
  return resource;
};
