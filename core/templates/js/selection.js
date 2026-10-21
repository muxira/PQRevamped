function preventSelection(element) {
    var preventSelection = false;

    function addHandler(element, event, handler) {
        if (element.attachEvent)
            element.attachEvent('on' + event, handler);
        else if (element.addEventListener)
            element.addEventListener(event, handler, false);
    }

    function removeSelection() {
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        } else if (document.selection && document.selection.clear)
            document.selection.clear();
    }

    function killCtrlA(event) {
        event = event || window.event;
        var sender = event.target || event.srcElement;

        if (sender.tagName.match(/INPUT|TEXTAREA/i))
            return;

        var key = event.keyCode || event.which;
        if (event.ctrlKey && key == 'A'.charCodeAt(0))
        {
            removeSelection();

            if (event.preventDefault)
                event.preventDefault();
            else
                event.returnValue = false;
        }
    }

    addHandler(element, 'mousemove', function () {
        if (preventSelection)
            removeSelection();
    });
    addHandler(element, 'mousedown', function (event) {
        event = event || window.event;
        var sender = event.target || event.srcElement;
        preventSelection = !sender.tagName.match(/INPUT|TEXTAREA/i);
    });

    // dblclick briefly selects text in some browsers - use mouseup/mousedown instead
    addHandler(element, 'mouseup', function () {
        if (preventSelection)
            removeSelection();
        preventSelection = false;
    });

    addHandler(element, 'keydown', killCtrlA);
    addHandler(element, 'keyup', killCtrlA);
}
