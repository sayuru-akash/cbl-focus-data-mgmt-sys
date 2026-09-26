import Foundation
import Vision
import ImageIO
DispatchQueue.global().async {
 do {
 let request = VNRecognizeTextRequest()
 request.recognitionLevel = CommandLine.arguments.contains("fast") ? .fast : .accurate
 request.recognitionLanguages = ["en-US"]
 request.usesLanguageCorrection = false
 try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
 let rows = (request.results ?? []).compactMap { o -> [String:Any]? in
 guard let t = o.topCandidates(1).first else {return nil}; let r = o.boundingBox
 return ["text":t.string,"confidence":t.confidence,"x":r.minX,"y":1-r.maxY,"width":r.width,"height":r.height]
 }
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:rows))
 exit(0)
 } catch {fputs("\(error)",stderr);exit(1)}
}
dispatchMain()
