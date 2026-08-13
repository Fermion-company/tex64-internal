import assert from "node:assert/strict";
import test from "node:test";
import { compileExpr, astToPgf, parseExpr } from "../Resources/web/app/pro-canvas/plot-math.js";
import { exprToLatex, latexToExpr } from "../Resources/web/app/pro-canvas/plot-latex.js";

test("plot AST serializes with minimal precedence and variable replacement",()=>{const quadratic=parseExpr("2*x^2"),trig=parseExpr("sin(deg(t))");assert.ok(quadratic);assert.ok(trig);assert.equal(astToPgf(quadratic,"x"),"2*x^2");assert.equal(astToPgf(trig,"x"),"sin(deg(x))");});
test("LaTeX plot expressions convert through the AST subset",()=>{const fraction=latexToExpr("\\frac{1}{2}x^{2}");assert.ok(fraction);assert.equal(compileExpr(fraction)?.(2),2);assert.equal(latexToExpr("\\sin\\left(x\\right)"),"sin(deg(x))");assert.equal(latexToExpr("2\\pi"),"2*pi");assert.equal(latexToExpr("\\log(x)"),"log10(x)");assert.equal(latexToExpr("\\int x"),null);});
test("pgf expressions convert to LaTeX only for supported trig idioms",()=>{assert.equal(exprToLatex("sin(deg(x))"),"\\sin\\left(x\\right)");assert.equal(exprToLatex("(x)^(2)"),"x^{2}");assert.match(exprToLatex("rad(asin(x))")||"",/^\\arcsin/);assert.equal(exprToLatex("sin(x)"),null);});
test("plot expression LaTeX round trips semantically",()=>{const source="sin(deg(x))+sqrt(x^2)+log10(x+2)",latex=exprToLatex(source);assert.ok(latex);const result=latexToExpr(latex);assert.ok(result);const x=.7;assert.ok(Math.abs(compileExpr(source)(x)-compileExpr(result)(x))<1e-9);});
