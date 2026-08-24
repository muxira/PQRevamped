(function () {
    function r(e, n, t) {
        function o(i, f) {
            if (!n[i]) {
                if (!e[i]) {
                    var c = "function" == typeof require && require;
                    if (!f && c) return c(i, !0);
                    if (u) return u(i, !0);
                    var a = new Error("Cannot find module '" + i + "'");
                    throw a.code = "MODULE_NOT_FOUND", a
                }
                var p = n[i] = {exports: {}};
                e[i][0].call(p.exports, function (r) {
                    var n = e[i][1][r];
                    return o(n || r)
                }, p, p.exports, r, e, n, t)
            }
            return n[i].exports
        }

        for (var u = "function" == typeof require && require, i = 0; i < t.length; i++) o(t[i]);
        return o
    }

    return r
})()({
    1: [function (require, module, exports) {
        "use strict";

        Object.defineProperty(exports, "__esModule", {
            value: true
        });
        exports["default"] = main;

        /**
         *
         * @param {HTMLElement} element елемент-контейнер с кнопками
         * @param {function} callback
         */
        function main(element, callback) {
            var controls = null;
            var buttons = {};

            for (var i = 0; i < element.children.length; i++) {
                var ch = element.children[i];

                if (ch.id === 'controls') {
                    controls = ch;
                    continue;
                }

                buttons[ch.id] = ch;
            }

            controls.addEventListener('click', function () {
                element.classList.toggle('collapsed');
            });

            var _loop = function _loop(k) {
                buttons[k].addEventListener('click', function () {
                    callback(k);
                });
            };

            for (var k in buttons) {
                _loop(k);
            }
        }

    }, {}], 2: [function (require, module, exports) {
        "use strict";

        var _emoji_layer = _interopRequireDefault(require("./emoji_layer.js"));

        function _interopRequireDefault(obj) {
            return obj && obj.__esModule ? obj : {"default": obj};
        }

        /**
         *
         * @param {HTMLElement} element root overlay element
         * @param {function} log log function
         */
        function run_emoji_overlay(element, log) {
            try {
                (0, _emoji_layer["default"])(element, function (msg) {
                    log("emoji callback: " + msg);
                });
            } catch (err) {
                console.error("emojies error: ", err);
            }
        }

        function main() {
            run();
            preventZoomAction();
        }

        main();

        function preventZoomAction() {
            document.addEventListener("dblclick", function (event) {
                event.preventDefault();
            }, {
                passive: false
            });
        } // --- dust

        function run() {
            // --- dust
            var container = document.querySelector("body.partyquiz bb#d220806");

            var _qselect = function _qselect(arg) {
                return container.querySelector(arg);
            };

            var shell = {
                log: _qselect("entry#log"),
                emoji_layer: _qselect("overlay#emoji_layer")
            };

            var log = function log(msg) {
                return shell.log.innerHTML += "<p>" + msg + "</p>";
            };

            run_emoji_overlay(shell.emoji_layer, log);
        }

    }, {"./emoji_layer.js": 1}]
}, {}, [2])

function blinkInputError(id) {
    const inputField = document.getElementById(id);
    if (!inputField) return;

    inputField.classList.add('blink-error');

    setTimeout(() => {
        inputField.classList.remove('blink-error');
    }, 300);
}

function blinkInput(id) {
    const inputField = document.getElementById(id);

    // Add the blink class to change the background color to green
    inputField.classList.add('blink');

    // Remove the blink class after 0.2 seconds to revert back to the original color
    setTimeout(() => {
        inputField.classList.remove('blink');
    }, 100);
}