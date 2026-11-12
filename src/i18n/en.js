// English chat messages. Placeholders look like {name}.
// To add a language, copy this file, translate the values and register it in ./index.js.
export default {
  // announcements
  nowPlaying: '▶ Now playing: {track} ({length}) — requested by {user}',
  playFailed: 'Could not play {title} — {reason}',
  youtubeBlocked: 'YouTube is refusing requests from this server (it often blocks data-center IPs). The queue is kept. How to fix it: [url]{url}[/url] — then {prefix}resume.',
  playbackHalted: 'Playback stopped because tracks keep failing: {reason}. The queue is kept — use {prefix}resume to try again.',
  live: 'live',

  // generic
  unknownCommand: 'Unknown command. Type {prefix}help',
  notAllowed: "You're not allowed to use this bot.",
  shuttingDown: 'Bot is shutting down',
  nothingPlaying: 'Nothing is playing right now.',
  pickRange: 'Enter a number between 1 and {max}.',
  busy: "I'm handling a lot of requests right now — try again in a moment.",
  slowDown: 'Slow down a little: try again in a few seconds.',
  blockedUrl: "That address is on a private network, so I won't open it.",

  // play / queue
  usagePlay: 'Usage: {prefix}play <YouTube link or search terms>',
  queueFull: 'The queue is full (max {max} tracks).',
  notFound: 'Not found: {reason}',
  tooLong: 'That track is too long (max {max}).',
  noResults: 'Nothing found.',
  playlistAdded: 'Added {count} tracks to the queue.',
  playlistAddedFrom: 'Added {count} tracks from {name} to the queue.',
  tooLongSkipped: ' (skipped {count} that were too long)',
  playingNow: 'Playing: {track} ({length})',
  queued: 'Queued (#{position}): {track} ({length})',

  // search
  usageSearch: 'Usage: {prefix}search <search terms>',
  searchFailed: 'Search failed: {reason}',
  searchResults: 'Results — pick one with {prefix}pick <number>:',
  searchFirst: 'Search first with {prefix}search.',

  // playback control
  skipped: 'Skipped: {title}',
  stopped: 'Stopped and cleared the queue.',
  alreadyPaused: 'Already paused.',
  paused: 'Paused. Use {prefix}resume to continue.',
  notPaused: 'Nothing is paused.',
  resumed: 'Resumed.',
  nowPlayingDetail: 'Playing: {track} — {elapsed} / {length}{state} — requested by {user}',
  pausedTag: ' [paused]',

  // queue management
  queueEmpty: 'The queue is empty.',
  queueMore: '… and {count} more',
  queueTotal: 'In queue: {count}, ~{duration} total — loop: {loop}',
  removed: 'Removed: {title}',
  cleared: 'Cleared the queue ({count} removed).',
  shuffled: 'Queue shuffled.',
  invalidLoop: 'Invalid mode. Options: {modes}',
  loopSet: 'Loop: {mode}',
  loopModes: { off: 'off', one: 'track', all: 'queue' },

  // channel self-check (posted once per channel)
  hintCodec: 'Heads-up: this channel uses {codec} (quality {quality}), which makes music sound poor. An admin can switch it to Opus Music, quality 10 (Edit Channel → Audio).',
  hintQuality: "Heads-up: this channel's audio quality is {quality}. For music, an admin can raise it to 10 (Edit Channel → Audio).",
  hintTalkPower: 'Heads-up: nobody can hear me in this channel. It needs talk power {needed} and I have {have}. An admin can give me more talk power or make me a talker.',

  // whoami
  whoami: '{name}: your unique ID is [b]{uid}[/b], server groups: {groups}. Admins can put these in ALLOWED_UIDS / ALLOWED_GROUPS.',

  // volume / channel
  volume: 'Volume: {volume}%',
  volumeRange: 'Enter a value between 0 and 100.',
  joined: 'Here I am!',
  joinFailed: "Couldn't join your channel: {reason}",
  clientNotFound: "couldn't find you",

  // help
  commandsTitle: 'Commands:',
  help: {
    play: 'Play or add to the end of the queue (YouTube link, playlist or search)',
    playnext: 'Add to the front of the queue',
    search: 'Search YouTube and list 5 results',
    pick: 'Queue a result from {prefix}search',
    skip: 'Skip the current track',
    stop: 'Stop and clear the queue',
    pause: 'Pause',
    resume: 'Resume (also retries after playback stopped on errors)',
    np: 'Show the current track',
    queue: 'Show the queue',
    remove: 'Remove a track from the queue',
    clear: 'Clear the queue (current track keeps playing)',
    shuffle: 'Shuffle the queue',
    loop: 'Loop mode: off / track / queue',
    vol: 'Show or set the volume',
    join: 'Move the bot to your channel',
    whoami: 'Show your unique ID and server groups (for access control)',
    help: 'This list',
  },
  usage: {
    play: '<link | search>',
    playnext: '<link | search>',
    search: '<search>',
    pick: '<number>',
    remove: '<number>',
    loop: '[off|one|all]',
    vol: '[0-100]',
  },

  // extra command names / loop mode names for this language (English ones always work)
  commandAliases: {},
  loopAliases: {},
};
