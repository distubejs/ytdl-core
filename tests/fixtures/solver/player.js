var _yt_player={};(function(g){var window=this;
"use strict";
var config={signatureTimestamp:20123};
// Signature transform: reverse, then drop the first character.
var sigT=function(a){return a.split("").reverse().join("").slice(1)};
// n transform: append the length.
var nT=function(a){return a+a.length};
var hook=function(){};
// A top-level call the solver must drop: the stub document has no methods.
document.addEventListener("load",hook);
var Q=function(a){this.base=a;this.params={}};
Q.prototype.set=function(a,b){this.params[a]=b};
Q.prototype.get=function(a){return this.params[a]};
Q.prototype.clone=function(){var a=new Q(this.base);a.params=Object.assign({},this.params);return a};
Q.prototype.apply=function(){var a=this.get("s");a&&this.set("s",encodeURIComponent(sigT(decodeURIComponent(a))));a=this.get("n");a&&this.set("n",nT(a));hook()};
g.build=function(a,b,c){var d=new Q(a);c&&d.set(b,c);d.set("alr","yes");return d};
})(_yt_player);
