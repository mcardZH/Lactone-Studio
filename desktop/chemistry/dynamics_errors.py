"""Diagnostics shared by both MD workers without loading the modeling engine."""


class Rejected(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def reject(code, message):
    raise Rejected(code, message)
