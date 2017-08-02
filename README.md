# twitter-chumbucket
Thieving Chumbucket!

## Looks for stolen tweets.

### Configuration

Visit https://apps.twitter.com/ to create an application. Copy `config.sample.json` to `config.json`, and place your Consumer Key and Consumer Secret in this file. (The examples given are an invalidated keypair, so use your own.)

### Usage

  Command line:
  `node index.js username [count]`

  Arguments:
  * `username` The username to scan. This could be your own, or the username of a suspected thieving chumbucket.
  * `[count]`  Optional: The count of tweets to scan. If omitted, defaults to the most recent 10 tweets.
