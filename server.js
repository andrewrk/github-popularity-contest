process.env.NODE_ENV = process.env.NODE_ENV || "dev";

var Batch = require('batch');
var superagent = require('superagent');
var express = require('express');
var path = require('path');
var consolidate = require('consolidate');
var swig = require('swig');
var assert = require('assert');
var http = require('http');

// collected data
var users = {};
var repos = {};

// cached/calculated data
var goodUsers = [];
var top100 = [];
var userPoints = {};
var userContribCount = {};
var userCount = 0;
var repoCount = 0;
var contribCount = 0;
var recentlyCrawled = [];

var nextRefresh = null;
var REFRESH_INTERVAL = 2000;
var MIN_POINT_THRESHOLD = 10;
var MAX_RECENTLY_CRAWLED = 20;

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
  var repo = repos[repoId];
  if (repo != null) {
    var ONE_HOUR = 1000 * 60 * 60;
    var diff = new Date() - repo.crawlDate;
    if (diff < ONE_HOUR ) {
      var minutesAgo = Math.round(diff / (1000 * 60));
      resp.render('crawl', {
        error: "that repo was last crawled " + minutesAgo + " minutes ago.",
      });
      return;
    }
  }
  crawlQueue.unshift(repoId);
  resp.render('crawl');
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
server.listen(port, host, function() {
  console.log(process.env.NODE_ENV + " listening at http://" + host + ":" + port + "/");
});

var crawlQueue = [];
var lastId = "";

crawlNextRepo();
setInterval(crawlNextRepo, 3000);

function crawlNextRepo() {
  var repoId = crawlQueue.shift();
  if (repoId) {
    crawlRepo(repoId, function(err) {
      if (err) {
        console.error("error crawling", err.stack);
        return;
      }
      console.log("crawled", repoId);
    });
  } else {
    // need to get next page of index
    ghApiGet("/repositories?since=" + lastId, function(err, allRepoPage) {
      if (err) {
        console.error("error listing repositories:", err.stack);
        return;
      }
      if (allRepoPage.length === 0 ) {
        // start over
        console.log("reached the end, starting over.");
        lastId = "";
        return;
      }
      for (var i = 0; i < allRepoPage.length; i += 1) {
        var thisRepo = allRepoPage[i];
        lastId = thisRepo.id;
        crawlQueue.push(thisRepo.full_name);
      }
      console.log("found", allRepoPage.length, "repositories");
    });
  }
}

function scheduleRefreshCalculations() {
  if (nextRefresh != null) return;
  nextRefresh = setTimeout(function() {
    nextRefresh = null;
    refreshCalculations();
  }, REFRESH_INTERVAL);
}

function refreshCalculations() {
  userPoints = {};
  userContribCount = {};
  repoCount = 0;
  userCount = 0;
  contribCount = 0;

  var i;
  for (var repoId in repos) {
    repoCount += 1;
    var repo = repos[repoId];
    var totalContribs = 0;
    var contributor;
    for (i = 0; i < repo.contributors.length; i += 1) {
      contributor = repo.contributors[i];
      totalContribs += contributor.contributions;
      contribCount += contributor.contributions;
    }
    repo.totalContribs = totalContribs;
    if (totalContribs === 0) continue;
    for (i = 0; i < repo.contributors.length; i += 1) {
      contributor = repo.contributors[i];
      var ownership = contributor.contributions / totalContribs;

      var prevPoints = userPoints[contributor.login];
      if (prevPoints == null) prevPoints = 0;
      userPoints[contributor.login] = prevPoints + ownership * repo.watchers;

      var prevContribCount = userContribCount[contributor.login];
      if (prevContribCount == null) prevContribCount = 0;
      userContribCount[contributor.login] = prevContribCount + contributor.contributions;
    }
  }

  // all users above a certain threshold
  goodUsers = [];
  for (var uid in userPoints) {
    userCount += 1;
    var score = userPoints[uid];
    users[uid].score = score;
    users[uid].contribCount = userContribCount[uid];
    if (score > MIN_POINT_THRESHOLD) {
      goodUsers.push(users[uid]);
    }
  }
  goodUsers.sort(function(a, b) {
    return b.score - a.score;
  });
  top100 = [];
  for (i = 0; i < 100 && i < goodUsers.length; i += 1) {
    top100.push(goodUsers[i]);
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
    repo.contributors = contribs;
    repos[repoId] = repo;

    repo.crawlDate = new Date();

    // add the user to our cached data
    contribs.forEach(function(contrib) {
      var user = users[contrib.login];
      if (user == null) {
        user = {};
        users[contrib.login] = user;
      }
      user.login = contrib.login;
      user.id = contrib.id;
      user.avatar_url = contrib.avatar_url;
      user.gravatar_id = contrib.gravatar_id;
      user.url = contrib.url;
    });

    scheduleRefreshCalculations();

    recentlyCrawled.unshift(repo);
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
