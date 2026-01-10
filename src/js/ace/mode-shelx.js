import ace from 'ace-builds/src-noconflict/ace';

ace.define('ace/mode/shelx_highlight_rules', ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text_highlight_rules'], function(require, exports, module) {
    var oop = require("ace/lib/oop");
    var TextHighlightRules = require("ace/mode/text_highlight_rules").TextHighlightRules;

    var ShelxHighlightRules = function() {
        this.$rules = {
            "start": [
                {
                    token: "comment",
                    regex: "REM.*$|!.*$"
                },
                {
                    token: "keyword", // Major commands
                    regex: "\\b(PART|CELL|FLAT|ZERR|LIST|SWAT|LATT|SYMM|L\\.S\\.|FREE|MPLA|MORE|ACTA|FMAP|PLAN|MOVE|END|BASF|HTAB|CGLS|BUMP|BIND|EQIV|BOND|WPDB|CONF|SIZE|TEMP|WGHT|FVAR|MOLE|DAMP|RESI|DISP|ABIN)\\b"
                },
                {
                    token: "support.function", // Directives/Special
                    regex: "\\b(TITL|SFAC|11\\.000000|11\\.00000|UNIT|AFIX|ANIS|WGHT|EXTI|TWIN|SADI|DELU|HFIX|EADP|FLAT|RIGU|SIMU|HKLF|SUMP|DFIX|OMIT|DANG|ISOR|BLOC|SHEL)\\b"
                },
                {
                    token: "text", // Atom names -> plain text (black)
                    regex: "\\b[A-Za-z][A-Za-z0-9]*\\b"
                },
                {
                    token: "constant.numeric", // Floats and Integers
                    regex: "[+-]?\\d+(?:(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)?\\b"
                },
                {
                    token: "text",
                    regex: "\\s+"
                }
            ]
        };
    };

    oop.inherits(ShelxHighlightRules, TextHighlightRules);
    exports.ShelxHighlightRules = ShelxHighlightRules;
});

ace.define('ace/mode/shelx', ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/shelx_highlight_rules'], function(require, exports, module) {
    var oop = require("ace/lib/oop");
    var TextMode = require("ace/mode/text").Mode;
    var ShelxHighlightRules = require("ace/mode/shelx_highlight_rules").ShelxHighlightRules;

    var Mode = function() {
        this.HighlightRules = ShelxHighlightRules;
    };
    oop.inherits(Mode, TextMode);

    (function() {
        // Extra logic if needed
    }).call(Mode.prototype);

    exports.Mode = Mode;
});
