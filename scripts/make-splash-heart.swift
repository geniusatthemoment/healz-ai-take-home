import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

let input = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
let output = URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL
let source = CGImageSourceCreateWithURL(input, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let width = image.width
let height = image.height
let bytesPerRow = width * 4
let colorSpace = CGColorSpaceCreateDeviceRGB()
var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
let context = CGContext(
  data: &pixels,
  width: width,
  height: height,
  bitsPerComponent: 8,
  bytesPerRow: bytesPerRow,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

func index(_ x: Int, _ y: Int) -> Int { (y * width + x) * 4 }
func isBackground(_ x: Int, _ y: Int) -> Bool {
  let i = index(x, y)
  let alpha = pixels[i + 3]
  if alpha < 8 { return true }
  // The heart outline is the dark barrier. Light pixels inside it remain
  // enclosed, while the outer circular background is reachable from edges.
  return pixels[i] > 100 && pixels[i + 1] > 100 && pixels[i + 2] > 100
}

var visited = [Bool](repeating: false, count: width * height)
var queue: [(Int, Int)] = []
for x in 0..<width {
  queue.append((x, 0)); queue.append((x, height - 1))
}
for y in 0..<height {
  queue.append((0, y)); queue.append((width - 1, y))
}

var cursor = 0
while cursor < queue.count {
  let (x, y) = queue[cursor]
  cursor += 1
  if x < 0 || y < 0 || x >= width || y >= height { continue }
  let visitedIndex = y * width + x
  if visited[visitedIndex] || !isBackground(x, y) { continue }
  visited[visitedIndex] = true
  queue.append((x + 1, y)); queue.append((x - 1, y))
  queue.append((x, y + 1)); queue.append((x, y - 1))
}

for y in 0..<height {
  for x in 0..<width {
    let outsideHeartBounds = x < 75 || x > width - 76 || y < 100 || y > height - 70
    let i = index(x, y)
    let darkOutline = pixels[i] < 155 && pixels[i + 1] < 155 && pixels[i + 2] < 155
    let insideHeartFill = x >= 125 && x <= 390 && y >= 150 && y <= 390
    let outsideLowerHeart = y > 420 && (x < 100 || x > 412)
    if visited[y * width + x] || outsideHeartBounds || outsideLowerHeart || (!darkOutline && !insideHeartFill) {
      pixels[i + 3] = 0
    }
  }
}

let outputImage = context.makeImage()!
let destination = CGImageDestinationCreateWithURL(output, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, outputImage, nil)
CGImageDestinationFinalize(destination)
