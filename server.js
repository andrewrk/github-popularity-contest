process.env.NODE_ENV = process.env.NODE_ENV || "dev";

var Batch = require('batch');
var superagent = require('superagent');
var express = require('express');
var path = require('path');
var consolidate = require('consolidate');
var swig = require('swig');
var assert = require('assert');
var http = require('http');
var mongo = require('mongodb');
var MongoClient = mongo.MongoClient;

var db;
var reposCollection;
var metaCollection;

// cached/calculated data
var goodUsers = [];
var top100 = [];
var userCount = 0;
var repoCount = 0;
var contribCount = 0;
var recentlyCrawled = [];
var calculating = false;

var nextRefresh = null;
var REFRESH_INTERVAL = 4000;
var MIN_POINT_THRESHOLD = 10;
var MAX_RECENTLY_CRAWLED = 20;
var CRAWL_INTERVAL = parseInt(process.env.CRAWL_INTERVAL || 3000, 10);

var GH_TOKEN = process.env.GITHUB_TOKEN;
assert.ok(GH_TOKEN);
var GH_ENDPOINT = "https://api.github.com";
var VIEWS_DIR = path.join(__dirname, 'views');

var app = express();

swig.init({
  root: VIEWS_DIR,
  allowErrors: true,
  cache: process.env.NODE_ENV === 'production',
  filters: require('./lib/swigfilters'),
});

app.engine('html', consolidate.swig);
app.set('view engine', 'html');
app.set('views', VIEWS_DIR);
app.set('env', process.env.NODE_ENV);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', function(req, resp) {
  resp.render('home', {
    users: top100,
    userCount: userCount,
    repoCount: repoCount,
    contribCount: contribCount,
    recentlyCrawled: recentlyCrawled,
  });
});

app.post('/crawl', express.bodyParser(), function(req, resp) {
  var repoId = req.body.repoId;
  if (!repoId) {
    resp.render('crawl', {error: 'invalid repoId: ' + repoId});
    return;
  }
  reposCollection.findOne({full_name: repoId}, function(err, repo) {
    if (err) {
      resp.render('crawl', {
        error: "error finding repo: " + err.message,
      });
      return;
    }
    if (repo != null) {
      var ONE_HOUR = 1000 * 60 * 60;
      var diff = new Date() - repo.crawlDate;
      if (diff < ONE_HOUR ) {
        var minutesAgo = Math.round(diff / (1000 * 60));
        resp.render('crawl', {
          error: "that repo was last crawled too recently: " +
            minutesAgo + " minutes ago.",
        });
        return;
      }
    }
    state.crawlQueue.unshift(repoId);
    resp.render('crawl');
  });
});

app.get('/find', function(req, resp) {
  var uid = req.query.user;

  var userIndex = null;
  var i, user;
  for (i = 0; i < goodUsers.length; i += 1) {
    user = goodUsers[i];
    if (user.login === uid) {
      userIndex = i;
    }
  }
  if (userIndex == null) {
    resp.render('find', {
      error: true,
    });
  }
  var start = Math.max(userIndex - 10, 0);
  var end = Math.min(userIndex + 10, goodUsers.length - 1);
  var results = [];
  for (i = start; i <= end; i += 1) {
    user = goodUsers[i];
    user.rank = i + 1;
    results.push(user);
  }
  resp.render('find', {
    users: results,
    rank: userIndex + 1,
  });
});

var server = http.createServer(app);
var port = process.env.PORT || 25751;
var host = process.env.HOST || "0.0.0.0";
var state = {
  id: 'meta',
  lastId: "",
  crawlQueue: [],
};


var dbUrl = "mongodb://127.0.0.1:27017/gh_pop_contest";
MongoClient.connect(dbUrl, function(err, mongoDb) {
  if (err) {
    console.error("Unable to connect to mongodb:", err.stack);
    return;
  }
  db = mongoDb;
  reposCollection = db.collection('repositories');
  metaCollection = db.collection('meta');

  loadState(function(err) {
    if (err) {
      console.error("Error loading state:", err.stack);
      return;
    }
    crawlNextRepo();
    setInterval(crawlNextRepo, CRAWL_INTERVAL);
    server.listen(port, host, function() {
      console.log(process.env.NODE_ENV + " listening at http://" + host + ":" + port + "/");
    });
  });
});

function crawlNextRepo() {
  var repoId = state.crawlQueue.shift();
  if (repoId) {
    crawlRepo(repoId, function(err) {
      if (err) {
        console.error("error crawling", err.stack);
        return;
      }
      saveState();
      console.log("crawled", repoId);
    });
  } else {
    // need to get next page of index
    ghApiGet("/repositories?since=" + state.lastId, function(err, allRepoPage) {
      if (err) {
        console.error("error listing repositories:", err.stack);
        return;
      }
      if (allRepoPage.length === 0 ) {
        // start over
        console.log("reached the end, starting over.");
        state.lastId = "";
        return;
      }
      for (var i = 0; i < allRepoPage.length; i += 1) {
        var thisRepo = allRepoPage[i];
        state.lastId = thisRepo.id;
        state.crawlQueue.push(thisRepo.full_name);
      }
      saveState();
      console.log("found", allRepoPage.length, "repositories");
    });
  }
}

function scheduleRefreshCalculations() {
  if (nextRefresh != null) return;
  nextRefresh = setTimeout(maybeRefresh, REFRESH_INTERVAL);

  function maybeRefresh() {
    if (calculating) {
      nextRefresh = setTimeout(maybeRefresh, REFRESH_INTERVAL);
    } else {
      nextRefresh = null;
      refreshCalculations();
    }
  }
}

function refreshCalculations() {
  calculating = true;

  var newRepoCount = 0;
  var newUserCount = 0;
  var newContribCount = 0;
  var newUserData = {};

  var cursor = reposCollection.find({});
  cursor.nextObject(handleNext);

  function handleNext(err, repo) {
    if (err) {
      console.error("error doing calculations:", err.stack);
      return;
    }
    if (repo == null) {
      processUsers();
      return;
    }

    newRepoCount += 1;
    newContribCount += repo.totalContribs;
    for (var i = 0; i < repo.contributors.length; i += 1) {
      var contributor = repo.contributors[i];
      var ownership = contributor.contributions / repo.totalContribs;

      var userData = newUserData[contributor.login];
      if (userData == null) {
        userData = contributor;
        userData.score = 0;
        userData.contribCount = 0;
      }

      userData.score += ownership * repo.watchers;
      userData.contribCount += contributor.contributions;

      newUserData[contributor.login] = userData;
    }
    cursor.nextObject(handleNext);
  }

  function processUsers() {
    // all users above a certain threshold
    goodUsers = [];
    for (var uid in newUserData) {
      newUserCount += 1;
      var user = newUserData[uid];
      if (user.score > MIN_POINT_THRESHOLD) goodUsers.push(user);
    }
    goodUsers.sort(function(a, b) {
      return b.score - a.score;
    });
    top100 = [];
    for (var i = 0; i < 100 && i < goodUsers.length; i += 1) {
      top100.push(goodUsers[i]);
    }

    repoCount = newRepoCount;
    userCount = newUserCount;
    contribCount = newContribCount;

    calculating = false;
  }
}

function crawlRepo(repoId, cb) {
  var batch = new Batch();
  batch.push(function(cb) {
    // get the star count
    ghApiGet("/repos/" + repoId, function(err, repo) {
      if (err) {
        cb(err);
      } else {
        cb(null, repo);
      }
    });
  });
  batch.push(function(cb) {
    // get the list of contributors and their commit counts
    ghApiGet("/repos/" + repoId + "/contributors", function(err, contribs) {
      if (err) {
        cb(err);
      } else {
        cb(null, contribs);
      }
    });
  });
  batch.end(function(err, results) {
    if (err) {
      cb(err);
      return;
    }
    var repo = results[0];
    var contribs = results[1];

    var totalContribs = 0;
    for (var i = 0; i < contribs.length; i += 1) {
      totalContribs += contribs[i].contributions;
    }

    var repoData = {
      full_name: repo.full_name,
      contributors: contribs,
      crawlDate: new Date(),
      watchers: repo.watchers,
      html_url: repo.html_url,
      totalContribs: totalContribs,
    };

    if (totalContribs > 0 && repo.watchers > 1) {
      reposCollection.update({full_name: repoId}, repoData, {upsert: true}, function(err) {
        if (err) {
          console.error("error adding repo to db:", err.stack);
        }
      });

      scheduleRefreshCalculations();
    }

    recentlyCrawled.unshift(repoData);
    if (recentlyCrawled.length > MAX_RECENTLY_CRAWLED) {
      recentlyCrawled.pop();
    }

    cb();
  });
}

function ghApiGet(urlPath, cb) {
  var url = GH_ENDPOINT + urlPath;
  var req = superagent.get(url);
  req.set('Authorization', 'token ' + GH_TOKEN);
  req.set('Accept', 'application/json');
  req.end(function(err, resp) {
    if (err) {
      cb(err);
    } else if (resp.ok) {
      cb(null, resp.body);
    } else {
      cb(new Error(url + " response status " + resp.status + ": " + resp.text));
    }
  });
}

function loadState(cb) {
  metaCollection.findOne({id: state.id}, function(err, newState) {
    if (err) return cb(err);
    if (newState != null) state = newState;
    cb();
  });
}

function saveState() {
  metaCollection.update({id: state.id}, state, {upsert: true}, cb);
  function cb(err) {
    if (err) {
      console.error("Error saving state:", err.stack);
    }
  }
}
