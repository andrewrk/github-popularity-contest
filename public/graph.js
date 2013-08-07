(function() {

var colors = [
  "#788EFF",
  "#2ED174",
  "#E68828",
  "#DF3739",
  "#DBD950",
  "#CD4CB8",
  "#6CC5CF",
  "#A2A2A2",
];
var sections = [];
for (var repoName in window.ghpcUserData.repos) {
  var amt = window.ghpcUserData.repos[repoName];
  var percent = amt / window.ghpcUserData.score;
  var anchorText = document.createTextNode(repoName);
  var anchor = document.createElement("a");
  anchor.setAttribute("href", "https://github.com/" + repoName);
  anchor.appendChild(anchorText);
  sections.push({
    node: anchor,
    percent: percent,
    amt: amt,
  });
}
sections.sort(function(a, b) {
  return b.percent - a.percent;
});
var otherPercent = 0;
var otherAmt = 0;
var otherStartIndex = sections.length;
var i, section;
for (i = 0; i < sections.length; i += 1) {
  section = sections[i];
  section.color = colors[i % colors.length];
  if (i >= 7 && section.percent < 0.10) {
    otherPercent += section.percent;
    otherAmt += section.amt;
    otherStartIndex = Math.min(otherStartIndex, i);
  }
}
if (otherStartIndex < sections.length) {
  sections.splice(otherStartIndex, sections.length - otherStartIndex, {
    node: document.createTextNode("Other"),
    percent: otherPercent,
    amt: otherAmt,
    color: colors[otherStartIndex % colors.length],
  });
}

var canvas = document.getElementById("graph");
var context = canvas.getContext("2d");
var ul = document.createElement("ul");
canvas.parentNode.appendChild(ul);

var centerX = canvas.width / 2;
var centerY = canvas.height / 2;
var radius = Math.min(centerX, centerY);

var r = 0;
for (i = 0; i < sections.length; i += 1) {
  // draw pie chart slice
  section = sections[i];
  var newR = r + section.percent * Math.PI * 2;
  context.beginPath();
  context.moveTo(centerX, centerY);
  context.lineTo(centerX + Math.cos(r) * radius, centerY + Math.sin(r) * radius);
  context.arc(centerX, centerY, radius, r, newR);
  context.lineTo(centerX, centerY);
  context.closePath();
  context.fillStyle = section.color;
  context.fill();
  context.strokeStyle = "#000000";
  context.lineWidth = 1;
  context.stroke();
  r = newR;

  // add li element
  var li = document.createElement("li");
  var box = document.createElement("div");
  var percent100 = Math.round(section.percent * 100);
  var amtRound = Math.round(section.amt);
  var liText = document.createTextNode(" - " + percent100 + "%, " + amtRound + " points");
  box.style.backgroundColor = section.color;
  box.style.width = "20px";
  box.style.height = "20px";
  box.style.float = "left";
  box.style.marginRight = "8px";
  li.style.listStyleType = "none";
  li.style.marginBottom = "4px";
  li.appendChild(box);
  li.appendChild(section.node);
  li.appendChild(liText);
  ul.appendChild(li);
}

})();
