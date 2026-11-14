/** A compact, searchable emoji catalog (no extra dependency). */
export type EmojiEntry = { e: string; n: string };

export const EMOJI_CATEGORIES: { name: string; items: EmojiEntry[] }[] = [
  {
    name: "Frequently used",
    items: [
      ["👍", "thumbsup +1 like"], ["❤️", "heart love"], ["😂", "joy laugh"], ["🎉", "tada party"],
      ["🙌", "raised hands celebrate"], ["👀", "eyes look"], ["✅", "white check mark done"], ["🔥", "fire lit"],
      ["🙏", "pray thanks please"], ["💯", "100 hundred"], ["🚀", "rocket ship launch"], ["👏", "clap applause"],
    ].map(([e, n]) => ({ e, n })),
  },
  {
    name: "Smileys",
    items: [
      ["😀", "grinning smile"], ["😃", "smiley"], ["😄", "smile happy"], ["😁", "grin"], ["😅", "sweat smile"],
      ["🤣", "rofl rolling"], ["🙂", "slight smile"], ["😉", "wink"], ["😊", "blush"], ["😇", "innocent halo"],
      ["🥰", "smiling hearts"], ["😍", "heart eyes"], ["🤩", "star struck"], ["😘", "kiss"], ["😋", "yum"],
      ["😜", "wink tongue"], ["🤪", "zany crazy"], ["🤗", "hug"], ["🤔", "thinking hmm"], ["🤫", "shush"],
      ["😐", "neutral"], ["😑", "expressionless"], ["🙄", "eye roll"], ["😏", "smirk"], ["😬", "grimace"],
      ["😌", "relieved"], ["😴", "sleeping"], ["😷", "mask sick"], ["🤒", "thermometer ill"], ["🤯", "mind blown"],
      ["🥳", "partying"], ["😎", "sunglasses cool"], ["🤓", "nerd"], ["😕", "confused"], ["😟", "worried"],
      ["😮", "open mouth wow"], ["😲", "astonished"], ["🥺", "pleading"], ["😢", "cry sad"], ["😭", "sob"],
      ["😱", "scream"], ["😤", "triumph huff"], ["😡", "rage angry"], ["🤬", "cursing"], ["💀", "skull dead"],
    ].map(([e, n]) => ({ e, n })),
  },
  {
    name: "People",
    items: [
      ["👋", "wave hello bye"], ["🤚", "raised back hand"], ["✋", "hand stop"], ["👌", "ok"], ["🤌", "pinched"],
      ["✌️", "victory peace"], ["🤞", "crossed fingers luck"], ["🤟", "love you"], ["🤘", "rock on"], ["👉", "point right"],
      ["👈", "point left"], ["👆", "point up"], ["👇", "point down"], ["👎", "thumbsdown -1 dislike"], ["✊", "fist"],
      ["🤝", "handshake deal"], ["💪", "muscle strong"], ["🧠", "brain"], ["🫡", "salute"], ["🤷", "shrug"],
      ["🙋", "raising hand"], ["🤦", "facepalm"], ["🙇", "bow"], ["💁", "tipping hand"], ["🧑‍💻", "technologist dev"],
    ].map(([e, n]) => ({ e, n })),
  },
  {
    name: "Nature & food",
    items: [
      ["🌟", "star glowing"], ["⭐", "star"], ["☀️", "sun"], ["🌈", "rainbow"], ["⚡", "zap lightning"],
      ["❄️", "snowflake"], ["🌱", "seedling grow"], ["🌸", "blossom"], ["🐶", "dog"], ["🐱", "cat"],
      ["🦄", "unicorn"], ["🐛", "bug"], ["☕", "coffee"], ["🍕", "pizza"], ["🍔", "burger"],
      ["🍩", "donut"], ["🎂", "cake birthday"], ["🍻", "beers cheers"], ["🥂", "champagne toast"], ["🍿", "popcorn"],
    ].map(([e, n]) => ({ e, n })),
  },
  {
    name: "Objects & symbols",
    items: [
      ["💡", "bulb idea"], ["📌", "pushpin pin"], ["📎", "paperclip"], ["📝", "memo note"], ["📅", "calendar date"],
      ["📈", "chart up"], ["📉", "chart down"], ["💻", "laptop computer"], ["📱", "phone mobile"], ["🔒", "lock"],
      ["🔑", "key"], ["🛠️", "tools"], ["⚙️", "gear settings"], ["🧪", "test tube"], ["🐞", "lady beetle bug"],
      ["📣", "mega announce"], ["🔔", "bell notification"], ["⏰", "alarm clock"], ["🏆", "trophy win"], ["🎯", "dart target"],
      ["❗", "exclamation"], ["❓", "question"], ["⚠️", "warning"], ["🚫", "no entry"], ["❌", "x cross"],
      ["➕", "plus add"], ["🟢", "green circle"], ["🟡", "yellow circle"], ["🔴", "red circle"], ["💬", "speech bubble"],
    ].map(([e, n]) => ({ e, n })),
  },
];

export const QUICK_REACTIONS = ["✅", "👀", "🙌"];
