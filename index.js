const fs = require('fs');
const FuzzySet = require('fuzzyset.js');
const partialConfig = require('./config.json');
const promiseRequest = require('request-promise-native');
const stringSimilarity = require('string-similarity');
const Twitter = require('twitter');
const urljoin = require('url-join');

const TWITTER_API_BASE = 'https://api.twitter.com';

const Log = {
  levels: ['trace', 'debug', 'info', 'warn', 'error'],  
  toIndex(s) {
    return Math.max(Log.levels.indexOf(s), 0);
  },
};
Object.assign(Log, {
  level: Log.toIndex(process.env.LOG_LEVEL || 'debug')
});
Log.levels.forEach(level => {
  const index = Log.toIndex(level);
  Log[level] = (...args) => {
    if (Log.level <= index) console[level](...args); // eslint-disable-line no-console
  };
  Log.always = console.info; // eslint-disable-line no-console
});

function getConfig() {
  if (partialConfig.bearer_token) return Promise.resolve(partialConfig);

  const secret = Buffer.from(
    `${partialConfig.consumer_key}:${partialConfig.consumer_secret}`,
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
    Object.assign(partialConfig, {bearer_token: response.access_token});
    return new Promise((resolve, reject) => {
      fs.writeFile('./config.json', 
                   JSON.stringify(partialConfig), 
                   (err) => err ? reject(err) : resolve(partialConfig));
    });
  });
}

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

function userName(userdata) {
  return `${userdata.name} (@${userdata.screen_name})`;
}

function buildSummary(incident) {
  const event = {
    description: `${userName(incident.theft.user)} stole a tweet from ${userName(incident.original.user)}`,
    confidence: Object.keys(incident.meta.similarity)
      .reduce((sum, key) => sum + incident.meta.similarity[key], 0) / (Object.keys(incident.meta.similarity).length || 1),
    original: incident.original.tweet,
    repost: incident.theft.tweet,
    data: incident
  };
  event.summary = `score: ${Math.round(event.confidence * 100)}%
    ${event.description}
      original: ${event.original}
      repost:   ${event.repost}
  `;
  return event;
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

getConfig().then(config => {
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
  organizeMatches(possibleThefts)
    .map(buildSummary)
    .sort((a, b) => a.confidence > b.confidence ? -1 : 1)
    .forEach(el => Log.always(el.summary));
}).catch(err => {
  Log.error('Failed:', err);
});