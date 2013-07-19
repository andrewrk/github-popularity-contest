var commaIt = require('comma-it').commaIt;

exports.round = function(input, places) {
  if (places == null) places = 0;
  var n = Math.pow(10, places);
  var typed = parseFloat(input, 10);
  return Math.round(typed * n) / n
};

exports.comma = function(input) {
  return commaIt(Math.round(input), {thousandSeperator: ','});
};
