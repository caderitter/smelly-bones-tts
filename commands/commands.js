import { SlashCommandBuilder } from "discord.js";

export default [
  {
    name: "starttts",
    description:
      "joins the channel you're in and speaks every message said in #no-mic",
  },
  {
    name: "stoptts",
    description: "leaves the channel",
  },
  {
    name: "setvoice",
    description: "sets the selected voice of the bot",
  },
  new SlashCommandBuilder()
    .setName("setbirthday")
    .setDescription("allows you to set a user's birthay")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("the user to set the birthday of")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription(
          "the birthday date in format MM/DD without leading zeros",
        )
        .setRequired(true),
    )
    .toJSON(),
  {
    name: "listbirthdays",
    description: "list all the currently stored birthdays",
  },
];
