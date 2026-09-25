/**
 * Curated emoji set for team and project icons (no heavy emoji dependency). Each entry is
 * `emoji keyword keyword …`; entries are separated by `|`.
 */
const RAW: ReadonlyArray<[category: string, entries: string]> = [
  [
    'Work',
    '🚀 rocket launch ship|📦 package box release|🛠️ tools build fix|⚙️ gear settings config|🔧 wrench fix|🔨 hammer build|🧰 toolbox kit|🧪 test tube experiment lab|🔬 microscope research|📈 chart up growth metrics|📊 bar chart stats analytics|📉 chart down|🗂️ dividers files|📁 folder|📂 open folder|🗃️ card box archive|📋 clipboard tasks|📝 memo notes write|✏️ pencil edit|🖊️ pen|📌 pin|📎 paperclip attachment|🔗 link|📅 calendar date|🗓️ spiral calendar schedule|⏰ alarm clock time|⏳ hourglass waiting|✅ check done|☑️ checkbox|✔️ check mark|❗ exclamation important|❓ question|💡 bulb idea|🎯 target goal|🏁 finish flag|🏆 trophy win|🥇 medal first|🔒 lock secure private|🔑 key access|🛡️ shield security|🐛 bug issue|🧩 puzzle piece plugin|🧱 brick infrastructure|🏗️ construction building|📣 megaphone announce marketing|📢 loudspeaker|💬 speech chat comment|📨 incoming envelope email|✉️ envelope mail|📮 postbox|💼 briefcase business|💰 money bag finance|💳 card payment billing|🧾 receipt invoice|🏷️ label tag|🔖 bookmark|📚 books docs|📖 book read|📰 newspaper news|🗞️ rolled newspaper|🎨 palette design art|🖌️ brush paint|✂️ scissors cut|📐 ruler design|🧭 compass direction|🗺️ map roadmap|🔍 search magnify|🔎 search|💾 floppy save|💿 disc|🖥️ desktop computer|💻 laptop|⌨️ keyboard|🖱️ mouse|📱 phone mobile app|📡 antenna signal|🛰️ satellite|🤖 robot bot agent ai|🧠 brain think|👾 alien game|🎮 game controller|🕹️ joystick',
  ],
  [
    'Smileys',
    '😀 grin happy|😃 smile|😄 laugh|😁 beam|😆 laughing|😅 sweat|😂 joy tears|🙂 slight smile|😉 wink|😊 blush|😇 angel|🥰 love|😍 heart eyes|🤩 star struck|😎 cool sunglasses|🤓 nerd|🧐 monocle|🤔 thinking|🤨 raised eyebrow|😐 neutral|😴 sleeping|🥱 yawn|😬 grimace|🙃 upside down|😮 surprised|😲 astonished|🤯 mind blown|😳 flushed|🥳 party|😤 triumph|😭 crying|😱 scream|😡 angry|🤬 cursing|💀 skull|👻 ghost|💩 poop|🤡 clown|👽 alien|🙈 see no evil monkey|🙉 hear no evil|🙊 speak no evil',
  ],
  [
    'People',
    '👋 wave hello|👍 thumbs up yes|👎 thumbs down no|👏 clap|🙌 raised hands|🙏 pray thanks|🤝 handshake deal|💪 muscle strong|✌️ victory peace|🤞 crossed fingers luck|👀 eyes look|🧑‍💻 technologist developer coder|👩‍💻 woman developer|👨‍💻 man developer|🧑‍🎨 artist|🧑‍🔬 scientist|🧑‍🚀 astronaut|🧑‍🏫 teacher|🧑‍🔧 mechanic|🥷 ninja|🦸 superhero|🧙 wizard mage|👑 crown king|🎩 top hat|🧢 cap|👓 glasses|🕶️ sunglasses',
  ],
  [
    'Nature',
    '🐶 dog|🐱 cat|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦉 owl|🦅 eagle|🦆 duck|🐝 bee|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🦎 lizard|🐙 octopus|🦑 squid|🦀 crab|🐠 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🦓 zebra|🦒 giraffe|🐘 elephant|🦔 hedgehog|🦄 unicorn|🐉 dragon|🌵 cactus|🌲 evergreen tree|🌳 tree|🌴 palm|🌱 seedling growth|🌿 herb|🍀 clover luck|🍁 maple leaf|🍄 mushroom|🌸 blossom|🌻 sunflower|🌹 rose|🌈 rainbow|☀️ sun|🌙 moon|⭐ star|🌟 glowing star|✨ sparkles|⚡ lightning zap fast|🔥 fire hot|💧 droplet water|🌊 wave ocean|❄️ snowflake cold|☁️ cloud|🌪️ tornado|🌍 earth globe world|🪐 planet',
  ],
  [
    'Food',
    '🍎 apple|🍊 orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🥑 avocado|🥕 carrot|🌽 corn|🌶️ pepper hot|🍞 bread|🧀 cheese|🍕 pizza|🍔 burger|🌮 taco|🍣 sushi|🍜 noodles ramen|🍩 donut|🍪 cookie|🎂 cake birthday|🍰 shortcake|🧁 cupcake|🍫 chocolate|🍿 popcorn|☕ coffee|🍵 tea|🧋 bubble tea|🍺 beer|🍷 wine|🥂 cheers',
  ],
  [
    'Activities',
    '⚽ soccer|🏀 basketball|🏈 football|⚾ baseball|🎾 tennis|🏐 volleyball|🏓 ping pong|🎳 bowling|⛳ golf|🎣 fishing|🏹 archery|🥊 boxing|🎿 ski|🏂 snowboard|🏄 surf|🚴 bike|🏃 run|🧗 climb|🧘 yoga|🎲 dice|♟️ chess|🧸 teddy|🎸 guitar|🎹 piano|🥁 drum|🎺 trumpet|🎧 headphones music|🎤 microphone|🎬 clapper film|📷 camera photo|🎭 theater|🎉 party popper celebrate|🎈 balloon|🎁 gift present',
  ],
  [
    'Travel',
    '🚗 car|🚕 taxi|🚌 bus|🚂 train|🚆 rail|✈️ airplane travel|🚁 helicopter|⛵ sailboat|🚢 ship|⚓ anchor|🛸 ufo|🏠 house home|🏢 office building|🏭 factory|🏰 castle|🗼 tower|🗽 statue liberty|⛺ tent camp|🏔️ mountain|🌋 volcano|🏝️ island|🏜️ desert|🌉 bridge|🚦 traffic light|🚧 construction wip|🛤️ railway track|🧳 luggage',
  ],
  [
    'Symbols',
    '❤️ red heart|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💯 hundred perfect|💥 boom|💫 dizzy|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟩 green square|🟦 blue square|🔶 orange diamond|🔷 blue diamond|🔺 red triangle|♻️ recycle|⚠️ warning|🚫 prohibited|⛔ no entry|🆕 new|🆗 ok|🆒 cool|🆘 sos|🔔 bell notification|🔕 mute|🎵 music note|➕ plus|➖ minus|✖️ multiply|➗ divide|♾️ infinity|🔄 refresh sync|🔁 repeat|▶️ play|⏸️ pause|⏹️ stop|⏩ fast forward|#️⃣ hash number|🔢 numbers|🔤 letters abc',
  ],
  [
    'Flags',
    '🏳️ white flag|🏴 black flag|🚩 red flag|🏳️‍🌈 rainbow flag|🏴‍☠️ pirate|🇺🇸 united states usa|🇬🇧 united kingdom uk|🇨🇦 canada|🇩🇪 germany|🇫🇷 france|🇪🇸 spain|🇮🇹 italy|🇯🇵 japan|🇰🇷 korea|🇨🇳 china|🇮🇳 india|🇧🇷 brazil|🇲🇽 mexico|🇦🇺 australia|🇳🇱 netherlands|🇸🇪 sweden|🇺🇦 ukraine|🇪🇺 european union eu',
  ],
];

export interface EmojiEntry {
  emoji: string;
  /** Lowercase keywords for search. */
  keywords: string;
}

export interface EmojiCategory {
  name: string;
  emojis: EmojiEntry[];
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = RAW.map(([name, entries]) => ({
  name,
  emojis: entries.split('|').map((entry) => {
    const [emoji = '', ...keywords] = entry.trim().split(' ');
    return { emoji, keywords: keywords.join(' ').toLowerCase() };
  }),
}));

/** Emojis whose keywords contain every word of the query. */
export function searchEmojis(query: string): EmojiEntry[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const seen = new Set<string>();
  const results: EmojiEntry[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const entry of category.emojis) {
      if (seen.has(entry.emoji)) continue;
      if (words.every((word) => entry.keywords.includes(word) || entry.emoji === word)) {
        seen.add(entry.emoji);
        results.push(entry);
      }
    }
  }
  return results;
}
