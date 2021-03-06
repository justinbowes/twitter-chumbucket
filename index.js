const fs = require('fs');
const config = require('./config.json');
const Log = require('./log');
const FuzzySet = require('fuzzyset.js');
const promiseRequest = require('request-promise-native');
const stringSimilarity = require('string-similarity');
const Table = require('cli-table2');
const Twitter = require('twitter');
const urljoin = require('url-join');

const TWITTER_API_BASE = 'https://api.twitter.com';


const [
  screen_name,
  explicitCount
] = [...process.argv].slice(2);
const count = explicitCount || 10;

if (! screen_name) {
  Log.always(`${process.argv0}
  Looks for stolen tweets.

  Command line:
  ${process.argv0} username [count]

  Arguments:
    username    The username to scan. This could be your own, or
                the username of a suspected thieving chumbucket.
    [count]     Optional: The count of tweets to scan. If omitted,
                defaults to the most recent 10 tweets.
`);
  process.exit(1);
} else {
  Log.always(`${process.argv0}
  Scanning last ${count} tweets in timeline for @${screen_name}
`);
}


function writeConfig() {
  return new Promise((resolve, reject) => {
    fs.writeFile('./config.json', 
                 JSON.stringify(config), 
                 (err) => err ? reject(err) : resolve(config));
  });
}

function readConfig() {
  if (config.bearer_token) return Promise.resolve(config);

  const secret = Buffer.from(
    `${config.consumer_key}:${config.consumer_secret}`,
    'utf-8'
  ).toString('base64');

  return promiseRequest({
    uri: urljoin(TWITTER_API_BASE, 'oauth2/token'),
    method: 'POST',
    headers: {
      'Authorization': `Basic ${secret}`,
    },
    formData: {
      grant_type: 'client_credentials'
    },
    json: true
  }).then(response => {
    Object.assign(config, {bearer_token: response.access_token});
    return writeConfig(config);
  });
}

function findMatchingTweets(client, tweets) {
  return tweets.map(tweet => {
    const { text } = tweet;
    return new Promise((resolve, reject) => {
      client.get('search/tweets', 
                 {q: text},
                 (error, matches) => {
                   if (error) reject(error);
                   resolve({tweet, matches});
                 });
    });
  });
}

function filterMatches(matchResults) {
  return matchResults.map(result => 
    result.then(tweetAndMatches => {
      const { tweet, matches } = tweetAndMatches;    
      return Promise.resolve({ 
        tweet, 
        matches: matches.statuses
          .filter(m => m.id_str !== tweet.id_str)
          .filter(m => !(m.retweeted || m.retweeted_status))
      });
    })
  );
}

const similarityMetrics = {
  diceCoeff: (x, y) => stringSimilarity.compareTwoStrings(x, y), 
  fuzzySet: (x, y) => (FuzzySet([x]).get(y) || [[0]]).shift().shift()
};

function buildTheftMetadata(theftPair) {
  const [origin, theft] = theftPair;
  return {
    meta: {
      similarity: Object.keys(similarityMetrics)
        .reduce((acc, key) => Object.assign(acc, {[key]: similarityMetrics[key](origin.text, theft.text)}), {})
    },
    original: {
      user: origin.user,
      date: origin.created_at,
      tweet: origin.text,
      data: origin
    },
    theft: {
      user: theft.user,
      date: theft.created_at,
      tweet: theft.text,
      data: theft
    }
  };
}

function organizeMatches(possibleThefts) {
  return possibleThefts
    .reduce((acc, elt) => elt.matches.length ? acc.concat(elt) : acc, []) // no-match
    .reduce((acc, elt) => acc.concat(elt.matches.map(match => [elt.tweet, match])), []) // create pairs
    .map(([first, second]) => // sort by created_at (establish authorship)
      Date.parse(first.created_at) < Date.parse(second.created_at) ? [first, second] : [second, first]
    )
    .map(buildTheftMetadata);
}

function userName(userdata) {
  return `${userdata.name} (@${userdata.screen_name})`;
}

function buildSummary(incident) {
  const confidence = Object.keys(incident.meta.similarity)
    .reduce((sum, key) => sum + incident.meta.similarity[key], 0) / (Object.keys(incident.meta.similarity).length || 1);
  const description =  `${userName(incident.theft.user)} stole a tweet from ${userName(incident.original.user)}`;
  return Object.assign(incident, {
    confidence,
    summary: `score: ${Math.round(confidence * 100)}%
    ${description}
      original (${incident.original.date})  : ${incident.original.tweet}
      repost   (${incident.theft.date})     : ${incident.theft.tweet}
  `
  });
}

readConfig().then(config => {
  const client = new Twitter(config);
  return new Promise((resolve, reject) => {
    client.get('statuses/user_timeline.json', 
               { screen_name, count, include_rts: false },
               (error, tweets) => {
                 if (error) reject(error);
                 resolve(
                   Promise.all(
                     filterMatches(
                       findMatchingTweets(client, tweets)
                     )
                   )
                 );
               });
  });
}).then(possibleThefts => {
  const width = process.env.columns || 135;
  const columnWeights = {
    'confidence': 10,
    'author': 20,
    'original date': 15,
    'thief': 20,
    'theft date': 15,
    'original text': 30,
    'repost': 30
  };
  const totalWeight = Object.keys(columnWeights).reduce((acc, key) => acc += columnWeights[key], 0);
  Object.keys(columnWeights).forEach(k => columnWeights[k] = Math.round(columnWeights[k] * width / totalWeight));
  const table = new Table({
    head: Object.keys(columnWeights),
    colWidths: Object.keys(columnWeights).map(k => columnWeights[k]),
    wordWrap: true
  });
  table.push.apply(
    table,
    organizeMatches(possibleThefts)
      .map(buildSummary)
      .sort((a, b) => a.confidence > b.confidence ? -1 : 1)
      .map(el => [
        Math.round(el.confidence * 100.0), 
        userName(el.original.user),
        el.original.date, 
        userName(el.theft.user), 
        el.theft.date,
        el.original.tweet,
        el.theft.tweet
      ])
  );
  Log.always(table.toString());
}).catch(err => {
  Log.error('Failed:', err);
  delete config.bearer_token;
  return writeConfig();
});