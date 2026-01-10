import ace from 'ace-builds/src-noconflict/ace';

ace.define('ace/mode/cif_highlight_rules', ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text_highlight_rules'], function(require, exports, module) {
    var oop = require("ace/lib/oop");
    var TextHighlightRules = require("ace/mode/text_highlight_rules").TextHighlightRules;

    var CifHighlightRules = function() {
        this.$rules = {
            "start": [
                {
                    token: "comment",
                    regex: "#.*$"
                },
                {
                    token: "string", // single line string
                    regex: "'.*?'"
                },
                {
                    token: "string", // single line string
                    regex: '".*?"'
                },
                {
                    token: "keyword", // data_ block
                    regex: "^data_[^\\s]*"
                },
                {
                    token: "keyword", // loop_
                    regex: "^loop_"
                },
                {
                    token: "variable", // tags
                    regex: "_[a-zA-Z0-9_]+"
                },
                {
                    token: "constant.numeric", // float
                    regex: "[+-]?\\d+(?:(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)?\\b"
                },
                {
                    token: "text",
                    regex: "\\s+"
                }
            ]
        };
    };

    oop.inherits(CifHighlightRules, TextHighlightRules);
    exports.CifHighlightRules = CifHighlightRules;
});

ace.define('ace/mode/cif', ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/cif_highlight_rules'], function(require, exports, module) {
    var oop = require("ace/lib/oop");
    var TextMode = require("ace/mode/text").Mode;
    var CifHighlightRules = require("ace/mode/cif_highlight_rules").CifHighlightRules;

    var Mode = function() {
        this.HighlightRules = CifHighlightRules;
    };
    oop.inherits(Mode, TextMode);

    (function() {
        // Extra logic if needed
    }).call(Mode.prototype);

    exports.Mode = Mode;
});
