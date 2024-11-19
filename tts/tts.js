import { createAudioResource } from "@discordjs/voice";
import textToSpeech from "@google-cloud/text-to-speech";
import { Readable } from "stream";

const client = new textToSpeech.TextToSpeechClient();

export const synthesize = async (text, voiceName) => {
  const request = {
    input: { text },
    voice: { name: voiceName, languageCode: voiceName.slice(0, 5) },
    audioConfig: { audioEncoding: "MP3" },
  };

  const [{ audioContent }] = await client.synthesizeSpeech(request);
  const stream = Readable.from(audioContent);
  const resource = createAudioResource(stream);
  return resource;
};

export const listVoices = async () => {
  const voicesResponse = await client.listVoices({ languageCode: "en-US" });
  return voicesResponse[0].voices;
};
