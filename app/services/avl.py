"""AVL ordered index: logarithmic lookup/update, ordered spatial partition traversal."""
from dataclasses import dataclass


@dataclass
class Node:
    key: object
    value: object
    left: object = None
    right: object = None
    height: int = 1


def height(n):
    return n.height if n else 0


def refresh(n):
    n.height = 1 + max(height(n.left), height(n.right))
    return n


def rotate(n, left):
    child = n.right if left else n.left
    if left:
        n.right, child.left = child.left, n
    else:
        n.left, child.right = child.right, n
    refresh(n)
    return refresh(child)


class AVL:
    def __init__(self):
        self.root = None
        self.size = 0

    def put(self, key, value):
        def insert(n):
            if n is None:
                self.size += 1
                return Node(key, value)
            if key == n.key:
                n.value = value
                return n
            if key < n.key:
                n.left = insert(n.left)
            else:
                n.right = insert(n.right)
            refresh(n)
            balance = height(n.left) - height(n.right)
            if balance > 1:
                if key > n.left.key:
                    n.left = rotate(n.left, True)
                return rotate(n, False)
            if balance < -1:
                if key < n.right.key:
                    n.right = rotate(n.right, False)
                return rotate(n, True)
            return n
        self.root = insert(self.root)

    def get(self, key, default=None):
        n = self.root
        while n:
            if key == n.key:
                return n.value
            n = n.left if key < n.key else n.right
        return default

    def items(self):
        def walk(n):
            if n:
                yield from walk(n.left)
                yield n.key, n.value
                yield from walk(n.right)
        return walk(self.root)
